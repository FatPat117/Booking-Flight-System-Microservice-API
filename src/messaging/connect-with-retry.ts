import type { Logger } from "../observability/logger.js";
import type { MessageConsumer } from "./message-consumer.js";
import type { MessagePublisher } from "./message-publisher.js";
import { createRabbitMqConsumer } from "./rabbitmq-consumer.js";
import { createRabbitMqPublisher } from "./rabbitmq-publisher.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type RetryDeps<T> = {
  connectionUrl: string;
  logger: Logger;
  role: "publisher" | "consumer";
  connect: () => Promise<T>;
  maxAttempts?: number;
  delayMs?: number;
};

/**
 * Bounded retry for AMQP connect (publisher or consumer).
 * Fail-fast after maxAttempts so a dead broker does not hang startup forever.
 *
 * Defaults (10 × 2s ≈ 20s) cover compose boot lag without masking a permanent outage.
 */
async function connectAmqpWithRetry<T>(deps: RetryDeps<T>): Promise<T> {
  const maxAttempts = deps.maxAttempts ?? 10;
  const delayMs = deps.delayMs ?? 2_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const client = await deps.connect();

      deps.logger.info("rabbitmq_connected", {
        role: deps.role,
        attempt,
        maxAttempts,
      });

      return client;
    } catch (error) {
      lastError = error;
      deps.logger.warn("rabbitmq_connect_retry", {
        role: deps.role,
        attempt,
        maxAttempts,
        error: error instanceof Error ? error.message : String(error),
      });

      if (attempt < maxAttempts) {
        await sleep(delayMs);
      }
    }
  }

  const detail =
    lastError instanceof Error ? lastError.message : String(lastError);

  throw new Error(
    `Failed to connect to RabbitMQ (${deps.role}) after ${String(maxAttempts)} attempts: ${detail}`,
  );
}

/** Separate connection from the consumer — publisher and consumer stay independent. */
export async function connectPublisherWithRetry(deps: {
  connectionUrl: string;
  logger: Logger;
  maxAttempts?: number;
  delayMs?: number;
}): Promise<MessagePublisher> {
  return connectAmqpWithRetry({
    connectionUrl: deps.connectionUrl,
    logger: deps.logger,
    role: "publisher",
    ...(deps.maxAttempts === undefined
      ? {}
      : { maxAttempts: deps.maxAttempts }),
    ...(deps.delayMs === undefined ? {} : { delayMs: deps.delayMs }),
    connect: () =>
      createRabbitMqPublisher({
        connectionUrl: deps.connectionUrl,
        logger: deps.logger,
      }),
  });
}

/** Separate connection from the publisher — crash/restart of one does not tear down the other. */
export async function connectConsumerWithRetry(deps: {
  connectionUrl: string;
  logger: Logger;
  maxAttempts?: number;
  delayMs?: number;
}): Promise<MessageConsumer> {
  return connectAmqpWithRetry({
    connectionUrl: deps.connectionUrl,
    logger: deps.logger,
    role: "consumer",
    ...(deps.maxAttempts === undefined
      ? {}
      : { maxAttempts: deps.maxAttempts }),
    ...(deps.delayMs === undefined ? {} : { delayMs: deps.delayMs }),
    connect: () =>
      createRabbitMqConsumer({
        connectionUrl: deps.connectionUrl,
        logger: deps.logger,
      }),
  });
}
