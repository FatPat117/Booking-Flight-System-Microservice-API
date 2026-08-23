import type { Job } from "../jobs/job-scheduler.js";
import type { MessagePublisher } from "../messaging/message-publisher.js";
import type { Logger } from "../observability/logger.js";
import type { OutboxRepository } from "./outbox-repository.js";

export function createOutboxRelayJob(deps: {
  outboxRepository: OutboxRepository;
  messagePublisher: MessagePublisher;
  logger: Logger;
  intervalMs: number;
  batchSize?: number;
}): Job {
  const batchSize = deps.batchSize ?? 20;

  return {
    name: "outbox-relay-job",
    intervalMs: deps.intervalMs,
    handler: async () => {
      const pending = deps.outboxRepository.findUnpublished(batchSize);

      for (const entry of pending) {
        try {
          await deps.messagePublisher.publish(entry.eventType, entry.payload);
          deps.outboxRepository.markPublished(entry.id);
        } catch (error) {
          deps.logger.error("outbox_publish_failed", {
            outboxId: entry.id,
            eventType: entry.eventType,
            error: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
    },
  };
}
