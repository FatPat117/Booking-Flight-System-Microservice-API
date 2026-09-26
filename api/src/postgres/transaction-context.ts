import { AsyncLocalStorage } from "node:async_hooks";
import type { DataSource, EntityManager } from "typeorm";

/**
 * Separate from observability/request-context.ts on purpose: a transaction's
 * lifetime is scoped to one PostgresTransactionRunner.run() call, not to one
 * HTTP request — a request could run zero, one, or several transactions, and
 * a caller with no HTTP request at all (a scheduled job, a script) still
 * needs to read "which EntityManager is my transaction on" the same way.
 */
type TransactionContext = Readonly<{
  manager: EntityManager;
}>;

const storage = new AsyncLocalStorage<TransactionContext>();

/**
 * Only PostgresTransactionRunner should call this — it is what makes the
 * transactional EntityManager visible to every repository invoked (directly
 * or transitively, across `await` boundaries) from inside `callback`.
 */
export function runWithTransactionManager<T>(
  manager: EntityManager,
  callback: () => T,
): T {
  return storage.run({ manager }, callback);
}

/** True while called from inside an active runWithTransactionManager. */
export function isInTransaction(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Repositories call this — never storage.getStore() directly — so the
 * "no transaction open" fallback lives in exactly one place.
 */
export function resolveEntityManager(dataSource: DataSource): EntityManager {
  return storage.getStore()?.manager ?? dataSource.manager;
}
