export type OutboxEntry = Readonly<{
  id: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}>;

export type OutboxRepository = Readonly<{
  /** Must run inside the caller's active SQLite transaction. */
  enqueue(entry: OutboxEntry): void;
  findUnpublished(limit: number): OutboxEntry[];
  markPublished(id: string): void;
}>;
