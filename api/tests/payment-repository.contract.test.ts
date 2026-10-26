import { runPaymentRepositoryContract } from "./contracts/payment-repository.contract.js";
import { createInMemoryPaymentRepository } from "./fakes/in-memory.js";

// No foreign keys in the fake: any id is a booking.
runPaymentRepositoryContract("in-memory", async () => ({
  repository: createInMemoryPaymentRepository(),
  seedBooking: async () => crypto.randomUUID(),
}));
