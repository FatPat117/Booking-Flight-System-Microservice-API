import assert from "node:assert/strict";
import test from "node:test";

import {
  type IdempotencyRepository,
  type IdempotencyScope,
  PAY_BOOKING_OPERATION,
} from "../../src/idempotency/idempotency-repository.js";

/**
 * What every IdempotencyRepository promises (Day 49B, Decision 14), run
 * against the in-memory fake (unit tier) and Postgres (integration tier).
 * Not a *.test.ts file: it registers tests only when a runner file calls it.
 *
 * attachPayment's success path needs a real payment row (foreign key), so it
 * is covered with the payment flow; here only its refusal is.
 */
const NOW = new Date("2026-11-01T00:00:00.000Z");
const LATER = new Date("2026-11-01T00:00:05.000Z");

function scopeOf(accountId: string): IdempotencyScope {
  return { accountId, operation: PAY_BOOKING_OPERATION };
}

const CREATED = { status: 201, body: { payment: { status: "SUCCEEDED" } } };

export function runIdempotencyRepositoryContract(
  implementation: string,
  setup: () => Promise<IdempotencyRepository>,
): void {
  const name = (behavior: string) =>
    `IdempotencyRepository contract (${implementation}): ${behavior}`;

  test(name("the first claim of a key owns it"), async () => {
    const repository = await setup();
    const scope = scopeOf(crypto.randomUUID());

    assert.deepEqual(await repository.claim(scope, "key-1", "fp-a", NOW), {
      outcome: "claimed",
    });
  });

  test(name("a second claim while the first is unfinished is in-progress, with the first fingerprint"), async () => {
    const repository = await setup();
    const scope = scopeOf(crypto.randomUUID());
    await repository.claim(scope, "key-1", "fp-a", NOW);

    assert.deepEqual(await repository.claim(scope, "key-1", "fp-b", LATER), {
      outcome: "in-progress",
      fingerprint: "fp-a",
    });
  });

  test(name("a claim after complete returns the stored response and the original fingerprint (BR-PAY-01/02)"), async () => {
    const repository = await setup();
    const scope = scopeOf(crypto.randomUUID());
    await repository.claim(scope, "key-1", "fp-a", NOW);
    await repository.complete(scope, "key-1", CREATED, LATER);

    for (const fingerprint of ["fp-a", "fp-other"]) {
      assert.deepEqual(await repository.claim(scope, "key-1", fingerprint, LATER), {
        outcome: "completed",
        fingerprint: "fp-a",
        response: CREATED,
      });
    }
  });

  test(name("a stored response keeps its JSON body exactly, nested objects and arrays included"), async () => {
    const repository = await setup();
    const scope = scopeOf(crypto.randomUUID());
    const response = {
      status: 402,
      body: {
        error: { code: "PAYMENT_DECLINED", message: "Declined", details: [{ reason: "card_declined" }] },
      },
    };
    await repository.claim(scope, "key-1", "fp-a", NOW);
    await repository.complete(scope, "key-1", response, LATER);

    const replay = await repository.claim(scope, "key-1", "fp-a", LATER);
    assert.equal(replay.outcome, "completed");
    assert.deepEqual(replay.outcome === "completed" ? replay.response : undefined, response);
    // Byte for byte, key order included: a replay is the same response, not
    // an equivalent one (jsonb would sort "details" before "message").
    assert.equal(
      JSON.stringify(replay.outcome === "completed" ? replay.response.body : undefined),
      JSON.stringify(response.body),
    );
  });

  test(name("the same key string from another account is a separate record"), async () => {
    const repository = await setup();
    const alice = scopeOf(crypto.randomUUID());
    const bob = scopeOf(crypto.randomUUID());
    await repository.claim(alice, "shared-key", "fp-alice", NOW);
    await repository.complete(alice, "shared-key", CREATED, LATER);

    assert.deepEqual(await repository.claim(bob, "shared-key", "fp-bob", LATER), {
      outcome: "claimed",
    });
    assert.deepEqual(await repository.claim(alice, "shared-key", "fp-alice", LATER), {
      outcome: "completed",
      fingerprint: "fp-alice",
      response: CREATED,
    });
  });

  test(name("release frees an unfinished key; the next claim owns it with its own fingerprint"), async () => {
    const repository = await setup();
    const scope = scopeOf(crypto.randomUUID());
    await repository.claim(scope, "key-1", "fp-a", NOW);
    await repository.release(scope, "key-1");

    assert.deepEqual(await repository.claim(scope, "key-1", "fp-b", LATER), {
      outcome: "claimed",
    });
    assert.deepEqual(await repository.claim(scope, "key-1", "fp-c", LATER), {
      outcome: "in-progress",
      fingerprint: "fp-b",
    });
  });

  test(name("release leaves a completed key and its response untouched"), async () => {
    const repository = await setup();
    const scope = scopeOf(crypto.randomUUID());
    await repository.claim(scope, "key-1", "fp-a", NOW);
    await repository.complete(scope, "key-1", CREATED, LATER);
    await repository.release(scope, "key-1");

    assert.equal((await repository.claim(scope, "key-1", "fp-a", LATER)).outcome, "completed");
  });

  test(name("complete and attachPayment throw for a key that is not in progress"), async () => {
    const repository = await setup();
    const scope = scopeOf(crypto.randomUUID());

    await assert.rejects(repository.complete(scope, "never-claimed", CREATED, NOW));
    await assert.rejects(repository.attachPayment(scope, "never-claimed", crypto.randomUUID()));

    await repository.claim(scope, "key-1", "fp-a", NOW);
    await repository.complete(scope, "key-1", CREATED, LATER);
    await assert.rejects(repository.complete(scope, "key-1", CREATED, LATER));
  });
}
