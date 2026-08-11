import type { MessageConsumer } from "./message-consumer.js";

/** No-op consumer for unit/API tests that do not need a real broker. */
export function createNoopMessageConsumer(): MessageConsumer {
  return {
    async subscribe() {},
    async close() {},
  };
}
