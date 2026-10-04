import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createRabbitMqPublisher,
  type PublisherChannel,
  type PublisherConnection,
} from "../src/messaging/rabbitmq-publisher.js";
import type { Logger } from "../src/observability/logger.js";

function createMemoryLogger() {
  const messages: string[] = [];

  const logger: Logger = {
    info(message) {
      messages.push(message);
    },
    warn(message) {
      messages.push(message);
    },
    error(message) {
      messages.push(message);
    },
  };

  return { logger, messages };
}

function createFakeConnection() {
  const connectionEvents = new EventEmitter();
  const channelEvents = new EventEmitter();
  const sentTo: string[] = [];
  let isChannelClosed = false;
  let isConnectionClosed = false;

  // Like amqplib: each close event fires once, a closing connection also
  // closes its channel, and closing an already-closed connection rejects.
  function closeChannel() {
    if (!isChannelClosed) {
      isChannelClosed = true;
      channelEvents.emit("close");
    }
  }

  function closeConnection(error?: Error) {
    if (isConnectionClosed) {
      throw new Error("Connection closed");
    }
    isConnectionClosed = true;
    closeChannel();
    connectionEvents.emit("close", error);
  }

  const channel: PublisherChannel = {
    async assertExchange() {
      return {};
    },
    async assertQueue() {
      return {};
    },
    sendToQueue(queue) {
      sentTo.push(queue);
      return true;
    },
    async close() {
      closeChannel();
    },
    on(event, listener) {
      channelEvents.on(event, listener);
      return channel;
    },
  };

  const connection: PublisherConnection = {
    async createChannel() {
      return channel;
    },
    async close() {
      closeConnection();
    },
    on(event, listener) {
      connectionEvents.on(event, listener);
      return connection;
    },
  };

  return {
    connection,
    sentTo,
    /** Simulates the broker force-closing the connection (e.g. RabbitMQ restart). */
    drop() {
      closeConnection(new Error("CONNECTION_FORCED"));
    },
  };
}

function createFakeBroker() {
  const connections: Array<ReturnType<typeof createFakeConnection>> = [];
  let failuresRemaining = 0;

  return {
    connections,
    failNextConnects(count: number) {
      failuresRemaining = count;
    },
    async connect(): Promise<PublisherConnection> {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("ECONNREFUSED");
      }
      const fake = createFakeConnection();
      connections.push(fake);
      return fake.connection;
    },
  };
}

test("publish after an unexpected connection loss opens a new connection", async () => {
  const broker = createFakeBroker();
  const { logger, messages } = createMemoryLogger();
  const publisher = await createRabbitMqPublisher({
    connectionUrl: "amqp://fake",
    logger,
    connect: () => broker.connect(),
  });

  broker.connections[0]?.drop();
  await publisher.publish("flight-created", { id: "f1" });

  assert.equal(broker.connections.length, 2);
  assert.deepEqual(broker.connections[0]?.sentTo, []);
  assert.deepEqual(broker.connections[1]?.sentTo, ["flight-created"]);
  assert.equal(
    messages.filter((message) => message === "rabbitmq_connection_lost").length,
    1,
  );
  assert.ok(messages.includes("rabbitmq_reconnected"));
});

test("concurrent publishes after a connection loss share one reconnect", async () => {
  const broker = createFakeBroker();
  const { logger } = createMemoryLogger();
  const publisher = await createRabbitMqPublisher({
    connectionUrl: "amqp://fake",
    logger,
    connect: () => broker.connect(),
  });

  broker.connections[0]?.drop();
  await Promise.all([
    publisher.publish("flight-created", { id: "f1" }),
    publisher.publish("booking-created", { id: "b1" }),
  ]);

  assert.equal(broker.connections.length, 2);
  assert.deepEqual(broker.connections[1]?.sentTo, [
    "flight-created",
    "booking-created",
  ]);
});

test("a failed reconnect rejects publish and the next publish tries again", async () => {
  const broker = createFakeBroker();
  const { logger } = createMemoryLogger();
  const publisher = await createRabbitMqPublisher({
    connectionUrl: "amqp://fake",
    logger,
    connect: () => broker.connect(),
  });

  broker.connections[0]?.drop();
  broker.failNextConnects(1);

  await assert.rejects(
    publisher.publish("flight-created", { id: "f1" }),
    /ECONNREFUSED/,
  );
  await publisher.publish("flight-created", { id: "f1" });

  assert.equal(broker.connections.length, 2);
  assert.deepEqual(broker.connections[1]?.sentTo, ["flight-created"]);
});

test("graceful close is not treated as a connection loss and does not reconnect", async () => {
  const broker = createFakeBroker();
  const { logger, messages } = createMemoryLogger();
  const publisher = await createRabbitMqPublisher({
    connectionUrl: "amqp://fake",
    logger,
    connect: () => broker.connect(),
  });

  await publisher.close();

  await assert.rejects(
    publisher.publish("flight-created", { id: "f1" }),
    /closed/,
  );
  assert.equal(broker.connections.length, 1);
  assert.equal(messages.includes("rabbitmq_connection_lost"), false);
});
