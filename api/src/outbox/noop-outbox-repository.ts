import type { OutboxRepository } from "./outbox-repository.js";

export function createNoopOutboxRepository(): OutboxRepository {
  return {
    async enqueue() {},
    async findUnpublished() {
      return [];
    },
    async markPublished() {},
  };
}
