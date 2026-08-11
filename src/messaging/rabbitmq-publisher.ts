
import amqplib, { type Channel, type ChannelModel } from "amqplib";
import type { Logger } from "../observability/logger.js";
import type { MessagePublisher } from "./message-publisher.js";

export async function createRabbitMqPublisher(deps: {
  connectionUrl: string;
  logger: Logger;
}): Promise<MessagePublisher> {
  const connection: ChannelModel = await amqplib.connect(deps.connectionUrl);
  const channel: Channel = await connection.createChannel();

  connection.on("error", (error) => {
    deps.logger.error("rabbitmq_connection_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  async function publish(destination: string, message: unknown): Promise<void> {
    await channel.assertQueue(destination, { durable: true });
    channel.sendToQueue(destination, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      contentType: "application/json",
    });
  }

  async function close(): Promise<void> {
    await channel.close();
    await connection.close();
  }

  return { publish, close };
}