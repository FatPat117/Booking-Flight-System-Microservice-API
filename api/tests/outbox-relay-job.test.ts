import assert from "node:assert/strict";
import test from "node:test";

import type { MessagePublisher } from "../src/messaging/message-publisher.js";
import { createOutboxRelayJob } from "../src/outbox/outbox-relay-job.js";
import type { OutboxEntry, OutboxRepository } from "../src/outbox/outbox-repository.js";
import type { Logger, LogFields } from "../src/observability/logger.js";

function createMemoryLogger() {
  const entries: Array<{
    level: string;
    message: string;
    fields?: LogFields;
  }> = [];

  const logger: Logger = {
    info(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "info", message }
          : { level: "info", message, fields },
      );
    },
    warn(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "warn", message }
          : { level: "warn", message, fields },
      );
    },
    error(message, fields) {
      entries.push(
        fields === undefined
          ? { level: "error", message }
          : { level: "error", message, fields },
      );
    },
  };

  return { logger, entries };
}

function makeEntry(id: string): OutboxEntry {
  return {
    id,
    eventType: "flight-created",
    payload: { type: "flight.created", flight: { id: "f1" } },
    createdAt: "2026-07-20T00:00:00.000Z",
  };
}

test("outbox relay publishes and marks successful entries", async () => {
  const published: Array<{ destination: string; message: unknown }> = [];
  const marked: string[] = [];

  const outboxRepository: OutboxRepository = {
    findUnpublished() {
      return [makeEntry("outbox-1")];
    },
    enqueue() {},
    markPublished(id) {
      marked.push(id);
    },
  };

  const messagePublisher: MessagePublisher = {
    async publish(destination, message) {
      published.push({ destination, message });
    },
    async close() {},
  };

  const job = createOutboxRelayJob({
    outboxRepository,
    messagePublisher,
    logger: createMemoryLogger().logger,
    intervalMs: 1_000,
  });

  await job.handler();

  assert.equal(published.length, 1);
  assert.equal(published[0]?.destination, "flight-created");
  assert.deepEqual(marked, ["outbox-1"]);
});

test("outbox relay logs publish failure and does not mark entry", async () => {
  const marked: string[] = [];
  const { logger, entries } = createMemoryLogger();

  const outboxRepository: OutboxRepository = {
    findUnpublished() {
      return [makeEntry("outbox-1")];
    },
    enqueue() {},
    markPublished(id) {
      marked.push(id);
    },
  };

  const messagePublisher: MessagePublisher = {
    async publish() {
      throw new Error("broker down");
    },
    async close() {},
  };

  const job = createOutboxRelayJob({
    outboxRepository,
    messagePublisher,
    logger,
    intervalMs: 1_000,
  });

  await job.handler();

  assert.deepEqual(marked, []);
  assert.ok(
    entries.some(
      (entry) =>
        entry.level === "error" &&
        entry.message === "outbox_publish_failed" &&
        entry.fields?.outboxId === "outbox-1",
    ),
  );
});

test("outbox relay stops batch after first publish failure to preserve order", async () => {
  const published: string[] = [];
  const marked: string[] = [];

  const outboxRepository: OutboxRepository = {
    findUnpublished() {
      return [makeEntry("first"), makeEntry("second")];
    },
    enqueue() {},
    markPublished(id) {
      marked.push(id);
    },
  };

  const messagePublisher: MessagePublisher = {
    async publish(_destination, message) {
      const payload = message as { flight?: { id?: string } };
      published.push(payload.flight?.id ?? "unknown");
      if (payload.flight?.id === "f1") {
        throw new Error("broker down");
      }
    },
    async close() {},
  };

  const job = createOutboxRelayJob({
    outboxRepository,
    messagePublisher,
    logger: createMemoryLogger().logger,
    intervalMs: 1_000,
  });

  await job.handler();

  assert.deepEqual(published, ["f1"]);
  assert.deepEqual(marked, []);
});
