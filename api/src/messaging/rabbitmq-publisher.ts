import amqplib from "amqplib";
import type { Logger } from "../observability/logger.js";
import type { MessagePublisher } from "./message-publisher.js";

type Listener = (error?: unknown) => void;

/**
 * Narrow view of amqplib's Channel/ChannelModel — only what this publisher
 * touches, so tests can fake a broker connection without RabbitMQ.
 */
export type PublisherChannel = {
  assertExchange(
    exchange: string,
    type: string,
    options: { durable: boolean },
  ): Promise<unknown>;
  assertQueue(
    queue: string,
    options: { durable: boolean; arguments: Record<string, unknown> },
  ): Promise<unknown>;
  sendToQueue(
    queue: string,
    content: Buffer,
    options: { persistent: boolean; contentType: string },
  ): boolean;
  close(): Promise<void>;
  on(event: "close" | "error", listener: Listener): unknown;
};

export type PublisherConnection = {
  createChannel(): Promise<PublisherChannel>;
  close(): Promise<void>;
  on(event: "close" | "error", listener: Listener): unknown;
};

type Session = Readonly<{
  connection: PublisherConnection;
  channel: PublisherChannel;
}>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reconnects lazily (Day 41): an unexpected close drops the current session
 * and the next publish() opens a new one. There is no background retry timer —
 * the outbox relay's interval is the retry cadence, and a failed publish just
 * leaves the outbox row unpublished for the next tick.
 *
 * The initial connect still throws, so connectPublisherWithRetry keeps startup
 * fail-fast.
 */
export async function createRabbitMqPublisher(deps: {
  connectionUrl: string;
  logger: Logger;
  connect?: (url: string) => Promise<PublisherConnection>;
}): Promise<MessagePublisher> {
  const { connectionUrl, logger } = deps;
  const connect = deps.connect ?? ((url: string) => amqplib.connect(url));

  let current: Session | undefined;
  let opening: Promise<Session> | undefined;
  let isClosing = false;

  function invalidate(session: Session, reason: string, error?: unknown) {
    // Identity check: a late close event from an old session (or from our own
    // close()) must not drop a newer one.
    if (current !== session) {
      return;
    }
    current = undefined;

    logger.error("rabbitmq_connection_lost", {
      role: "publisher",
      reason,
      ...(error === undefined ? {} : { error: describeError(error) }),
    });

    // A channel can close while its connection stays open (channel-level
    // error); close the connection too so the next session starts clean.
    session.connection.close().catch(() => undefined);
  }

  async function open(): Promise<Session> {
    const connection = await connect(connectionUrl);
    let session: Session | undefined;

    connection.on("error", (error) => {
      logger.error("rabbitmq_connection_error", {
        error: describeError(error),
      });
    });
    connection.on("close", (error) => {
      if (session !== undefined) {
        invalidate(session, "connection_closed", error);
      }
    });

    let channel: PublisherChannel;
    try {
      channel = await connection.createChannel();
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }

    const opened: Session = { connection, channel };
    session = opened;

    channel.on("error", (error) => {
      logger.error("rabbitmq_channel_error", { error: describeError(error) });
    });
    channel.on("close", () => {
      invalidate(opened, "channel_closed");
    });

    return opened;
  }

  async function getSession(): Promise<Session> {
    if (current !== undefined) {
      return current;
    }
    if (isClosing) {
      throw new Error("RabbitMQ publisher is closed");
    }

    // Concurrent publishes after a drop share one reconnect attempt.
    opening ??= open()
      .then((session) => {
        current = session;
        logger.info("rabbitmq_reconnected", { role: "publisher" });
        return session;
      })
      .finally(() => {
        opening = undefined;
      });

    return opening;
  }

  current = await open();

  async function publish(destination: string, message: unknown): Promise<void> {
    const { channel } = await getSession();
    const dlxName = `${destination}.dlx`;
    await channel.assertExchange(dlxName, "fanout", { durable: true });
    await channel.assertQueue(destination, {
      durable: true,
      arguments: { "x-dead-letter-exchange": dlxName },
    });
    channel.sendToQueue(destination, Buffer.from(JSON.stringify(message)), {
      persistent: true,
      contentType: "application/json",
    });
  }

  async function close(): Promise<void> {
    isClosing = true;
    await opening?.catch(() => undefined);

    const session = current;
    // Cleared before closing so our own close events are not "connection lost".
    current = undefined;
    if (session === undefined) {
      return;
    }

    await session.channel.close();
    await session.connection.close();
  }

  return { publish, close };
}
