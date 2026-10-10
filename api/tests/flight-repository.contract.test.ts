import { runFlightRepositoryContract } from "./contracts/flight-repository.contract.js";
import { createInMemoryFlightRepository } from "./fakes/in-memory.js";

runFlightRepositoryContract("in-memory", async () =>
  createInMemoryFlightRepository(),
);
