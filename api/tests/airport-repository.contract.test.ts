import { runAirportRepositoryContract } from "./contracts/airport-repository.contract.js";
import { createInMemoryAirportRepository } from "./fakes/in-memory.js";

runAirportRepositoryContract("in-memory", async () =>
  createInMemoryAirportRepository(),
);
