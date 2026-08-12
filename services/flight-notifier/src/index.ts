import { createConsoleLogger } from "./observability/logger.js";
import {
  connectConsumerWithRetry,
  redactAmqpUrl,
} from "./messaging/connect-with-retry.js";
import { createFlightCreatedConsumer } from "./messaging/flight-created-consumer.js";

export const FLIGHT_CREATED_QUEUE = "flight-created";

const logger = createConsoleLogger();

async function main() {
  const rabbitmqUrl =
    process.env.RABBITMQ_URL ?? "amqp://guest:guest@localhost:5672";

  logger.info("flight_notifier_starting", {
    rabbitmqUrl: redactAmqpUrl(rabbitmqUrl),
  });

  const consumer = await connectConsumerWithRetry({
    connectionUrl: rabbitmqUrl,
    logger,
    maxAttempts: 10,
    delayMs: 2_000,
  });

  await consumer.subscribe(
    FLIGHT_CREATED_QUEUE,
    createFlightCreatedConsumer({ logger }),
  );

  logger.info("flight_notifier_ready", {});

  async function shutdown(signal: string) {
    logger.info("flight_notifier_shutdown_started", { signal });
    await consumer.close();
    logger.info("flight_notifier_shutdown_completed", {});
    process.exit(0);
  }

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

main().catch((error) => {
  logger.error("flight_notifier_fatal_startup_error", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
