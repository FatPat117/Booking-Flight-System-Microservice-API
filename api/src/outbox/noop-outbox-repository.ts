import type { OutboxRepository } from "./outbox-repository.js";

export function createNoopOutboxRepository(): OutboxRepository {
  return {
    enqueue() {},
    findUnpublished() {
      return [];
    },
    markPublished() {},
  };
}
