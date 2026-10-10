import assert from "node:assert/strict";
import test from "node:test";

import type {
  Airport,
  AirportRepository,
} from "../../src/airports/airport-repository.js";

/**
 * What every AirportRepository promises, run against the in-memory fake
 * (unit tier) and Postgres (integration tier). Not a *.test.ts file: it
 * registers tests only when a runner file calls it.
 */
function makeAirport(code: string): Airport {
  return {
    id: crypto.randomUUID(),
    code,
    name: `${code} International`,
    city: `${code} City`,
    timeZone: "Asia/Ho_Chi_Minh",
    createdAt: "2026-10-10T00:00:00.000Z",
  };
}

export function runAirportRepositoryContract(
  implementation: string,
  setup: () => Promise<AirportRepository>,
): void {
  const name = (behavior: string) =>
    `AirportRepository contract (${implementation}): ${behavior}`;

  test(name("a created airport is listed with every field"), async () => {
    const repository = await setup();
    const airport = makeAirport("DAD");

    assert.deepEqual(await repository.create(airport), { outcome: "created" });
    assert.deepEqual(await repository.findPage({ limit: 10, offset: 0 }), {
      items: [airport],
      totalItems: 1,
    });
  });

  test(name("a taken code is duplicate and the first airport is kept (BR-REF-01)"), async () => {
    const repository = await setup();
    const first = makeAirport("SGN");

    await repository.create(first);
    const result = await repository.create({
      ...makeAirport("SGN"),
      name: "Impostor",
    });

    assert.deepEqual(result, { outcome: "duplicate" });
    const page = await repository.findPage({ limit: 10, offset: 0 });
    assert.deepEqual(page.items, [first]);
  });

  test(name("airports are listed by code, paged, with the collection total"), async () => {
    const repository = await setup();

    for (const code of ["LHR", "DAD", "SGN", "HAN"]) {
      await repository.create(makeAirport(code));
    }

    const page = await repository.findPage({ limit: 2, offset: 1 });

    assert.deepEqual(
      page.items.map((airport) => airport.code),
      ["HAN", "LHR"],
    );
    assert.equal(page.totalItems, 4);
  });
}
