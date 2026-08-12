import type { Logger } from "../observability/logger.js";
import type { MessageConsumer } from "./message-consumer.js";
import { createRabbitMqConsumer } from "./rabbitmq-consumer.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function connectConsumerWithRetry(deps: {
  connectionUrl: string;
  logger: Logger;
  maxAttempts?: number;
  delayMs?: number;
}): Promise<MessageConsumer> {
  const maxAttempts = deps.maxAttempts ?? 10;
  const delayMs = deps.delayMs ?? 2_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const consumer = await createRabbitMqConsumer({
        connectionUrl: deps.connectionUrl,
        logger: deps.logger,
      });

      deps.logger.info("rabbitmq_connected", {
        role: "consumer",
        attempt,
        maxAttempts,
      });

      return consumer;
    } catch (error) {
      lastError = error;
      deps.logger.warn("rabbitmq_connect_retry", {
        role: "consumer",
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
    `Failed to connect to RabbitMQ (consumer) after ${String(maxAttempts)} attempts: ${detail}`,
  );
}

function redactAmqpUrl(url: string): string {
  return url.replace(/\/\/.*@/, "//***@");
}

export { redactAmqpUrl };
