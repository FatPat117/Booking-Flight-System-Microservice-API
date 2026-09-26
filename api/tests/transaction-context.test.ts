import assert from "node:assert/strict";
import test from "node:test";
import type { DataSource, EntityManager } from "typeorm";

import {
  isInTransaction,
  resolveEntityManager,
  runWithTransactionManager,
} from "../src/postgres/transaction-context.js";

function makeFakeDataSource(manager: EntityManager): DataSource {
  return { manager } as unknown as DataSource;
}

test("outside any transaction, isInTransaction is false and resolveEntityManager falls back to dataSource.manager", () => {
  const defaultManager = {} as EntityManager;
  const dataSource = makeFakeDataSource(defaultManager);

  assert.equal(isInTransaction(), false);
  assert.equal(resolveEntityManager(dataSource), defaultManager);
});

test("inside runWithTransactionManager, isInTransaction is true and resolveEntityManager returns the transaction's manager", () => {
  const transactionManager = {} as EntityManager;
  const dataSource = makeFakeDataSource({} as EntityManager);

  runWithTransactionManager(transactionManager, () => {
    assert.equal(isInTransaction(), true);
    assert.equal(resolveEntityManager(dataSource), transactionManager);
  });
});

test("transaction context survives an await inside the callback", async () => {
  const transactionManager = {} as EntityManager;
  const dataSource = makeFakeDataSource({} as EntityManager);

  const observedManager = await runWithTransactionManager(
    transactionManager,
    async () => {
      await Promise.resolve();
      return resolveEntityManager(dataSource);
    },
  );

  assert.equal(observedManager, transactionManager);
});

test("context does not leak after runWithTransactionManager returns", async () => {
  const transactionManager = {} as EntityManager;
  const defaultManager = {} as EntityManager;
  const dataSource = makeFakeDataSource(defaultManager);

  await runWithTransactionManager(transactionManager, async () => undefined);

  assert.equal(isInTransaction(), false);
  assert.equal(resolveEntityManager(dataSource), defaultManager);
});
