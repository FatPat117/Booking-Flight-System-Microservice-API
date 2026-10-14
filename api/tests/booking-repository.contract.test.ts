import assert from "node:assert/strict";

import { runBookingRepositoryContract } from "./contracts/booking-repository.contract.js";
import {
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";

runBookingRepositoryContract("in-memory", async () => {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);
  const transactionRunner = createInMemoryTransactionRunner();

  return {
    repository: createInMemoryBookingRepository({ flights }),
    transaction: (work) => transactionRunner.run(work),
    async insertFlight(flight) {
      assert.deepEqual(await flightRepository.create(flight), { outcome: "created" });
    },
  };
});
