import { runAdminReportsContract } from "./contracts/admin-reports.contract.js";
import {
  createInMemoryAdminReports,
  createInMemoryAuditRecorder,
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";
import { TEST_AIRPORTS } from "./fixtures/flights.js";

runAdminReportsContract("in-memory", async () => {
  const store = createInMemoryFlightStore();
  const bookings = createInMemoryBookingRepository({ flights: store });
  const audit = createInMemoryAuditRecorder();
  const transactionRunner = createInMemoryTransactionRunner();

  return {
    reports: createInMemoryAdminReports({ flights: store, bookings, audit, airports: TEST_AIRPORTS }),
    flights: createInMemoryFlightRepository(store),
    bookings,
    transaction: (work) => transactionRunner.run(work),
    record: (entry) => audit.record(entry),
  };
});
