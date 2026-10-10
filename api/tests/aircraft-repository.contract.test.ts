import { runAircraftRepositoryContract } from "./contracts/aircraft-repository.contract.js";
import { createInMemoryAircraftRepository } from "./fakes/in-memory.js";

runAircraftRepositoryContract("in-memory", async () =>
  createInMemoryAircraftRepository(),
);
