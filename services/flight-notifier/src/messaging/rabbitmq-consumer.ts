import amqplib, {
  type Channel,
  type ChannelModel,
  type ConsumeMessage,
} from "amqplib";

import type { Logger } from "../observability/logger.js";
import type { MessageConsumer, MessageHandler } from "./message-consumer.js";

export async function createRabbitMqConsumer(deps: {
  connectionUrl: string;
  logger: Logger;
}): Promise<MessageConsumer> {
  const connection: ChannelModel = await amqplib.connect(deps.connectionUrl);
  const channel: Channel = await connection.createChannel();
  await channel.prefetch(1);

  connection.on("error", (error) => {
    deps.logger.error("rabbitmq_consumer_connection_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  async function subscribe(
    source: string,
    handler: MessageHandler,
  ): Promise<void> {
    const dlxName = `${source}.dlx`;
    const dlqName = `${source}.dlq`;

    await channel.assertExchange(dlxName, "fanout", { durable: true });
    await channel.assertQueue(dlqName, { durable: true });
    await channel.bindQueue(dlqName, dlxName, "");

    await channel.assertQueue(source, {
      durable: true,
      arguments: { "x-dead-letter-exchange": dlxName },
    });

    await channel.consume(
      source,
      async (message: ConsumeMessage | null) => {
        if (message === null) {
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(message.content.toString("utf8"));
        } catch (error) {
          deps.logger.error("message_parse_failed", {
            queue: source,
            error: error instanceof Error ? error.message : String(error),
          });
          channel.nack(message, false, false);
          return;
        }

        try {
          const result = await handler(payload);

          if (result.outcome === "processed") {
            channel.ack(message);
            return;
          }

          deps.logger.error("message_rejected", {
            queue: source,
            reason: result.reason,
          });
          channel.nack(message, false, false);
        } catch (error) {
          deps.logger.error("message_handler_failed", {
            queue: source,
            error: error instanceof Error ? error.message : String(error),
          });
          channel.nack(message, false, false);
        }
      },
      { noAck: false },
    );
  }

  async function close(): Promise<void> {
    await channel.close();
    await connection.close();
  }

  return { subscribe, close };
}
