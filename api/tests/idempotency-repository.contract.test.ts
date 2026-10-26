import { runIdempotencyRepositoryContract } from "./contracts/idempotency-repository.contract.js";
import { createInMemoryIdempotencyRepository } from "./fakes/in-memory.js";

runIdempotencyRepositoryContract("in-memory", async () =>
  createInMemoryIdempotencyRepository(),
);
