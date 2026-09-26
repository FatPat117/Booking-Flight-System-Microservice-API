export type OutboxEntry = Readonly<{
  id: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
}>;

export type OutboxRepository = Readonly<{
  /**
   * Must run inside the caller's active transaction to be atomic with the
   * business write beside it (ADR-001). SQLite enforces this implicitly
   * (single shared connection); the Postgres implementation throws if
   * called outside a transaction (see OutboxEnqueueOutsideTransactionError).
   */
  enqueue(entry: OutboxEntry): Promise<void>;
  findUnpublished(limit: number): Promise<OutboxEntry[]>;
  markPublished(id: string): Promise<void>;
}>;
