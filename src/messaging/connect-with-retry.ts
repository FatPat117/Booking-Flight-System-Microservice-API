import type { Logger } from "../observability/logger.js";
import type { MessagePublisher } from "./message-publisher.js";
import { createRabbitMqPublisher } from "./rabbitmq-publisher.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Connect to RabbitMQ with bounded retries.
 * Fail-fast after maxAttempts so a dead broker does not hang startup forever.
 *
 * Defaults (10 × 2s ≈ 20s) cover compose boot lag without masking a permanent outage.
 */
export async function connectWithRetry(deps: {
  connectionUrl: string;
  logger: Logger;
  maxAttempts?: number;
  delayMs?: number;
}): Promise<MessagePublisher> {
  const maxAttempts = deps.maxAttempts ?? 10;
  const delayMs = deps.delayMs ?? 2_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const publisher = await createRabbitMqPublisher({
        connectionUrl: deps.connectionUrl,
        logger: deps.logger,
      });

      deps.logger.info("rabbitmq_connected", {
        attempt,
        maxAttempts,
      });

      return publisher;
    } catch (error) {
      lastError = error;
      deps.logger.warn("rabbitmq_connect_retry", {
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
    `Failed to connect to RabbitMQ after ${String(maxAttempts)} attempts: ${detail}`,
  );
}
