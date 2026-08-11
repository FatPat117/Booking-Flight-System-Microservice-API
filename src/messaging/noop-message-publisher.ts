import type { MessagePublisher } from "./message-publisher.js";

/** No-op publisher for unit/API tests that do not need a real broker. */
export function createNoopMessagePublisher(): MessagePublisher {
  return {
    async publish() {},
    async close() {},
  };
}
