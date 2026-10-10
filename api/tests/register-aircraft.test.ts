import assert from "node:assert/strict";
import test from "node:test";

import { createRegisterAircraft } from "../src/aircraft/register-aircraft.js";
import {
  createInMemoryAircraftRepository,
  createInMemoryAuditRecorder,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";

const FIXED_TIME = new Date("2026-10-10T00:00:00.000Z");
const ADMIN = { accountId: "aaaaaaaa-0000-4000-8000-000000000001" };
const A321 = {
  registration: "vn-a321",
  model: "Airbus A321",
  seatLayout: {
    cabins: [
      { fareClass: "BUSINESS", fromRow: 1, toRow: 2, seatLetters: "ACDF" },
      { fareClass: "ECONOMY", fromRow: 3, toRow: 7, seatLetters: "ABCDEF" },
    ],
  },
};

function createContext() {
  const aircraftRepository = createInMemoryAircraftRepository();
  const audit = createInMemoryAuditRecorder();
  let nextId = 0;

  const registerAircraft = createRegisterAircraft({
    aircraftRepository,
    auditRecorder: audit,
    transactionRunner: createInMemoryTransactionRunner(),
    generateId: () => `c0ffee00-0000-4000-8000-00000000000${(nextId += 1)}`,
    generateAuditId: () => "audit-1",
    getRequestId: () => undefined,
    getCurrentTime: () => FIXED_TIME,
  });

  return { registerAircraft, aircraftRepository, audit };
}

test("an aircraft is created with its expanded layout and audited with seat counts (US-REF-02)", async () => {
  const { registerAircraft, aircraftRepository, audit } = createContext();

  const result = await registerAircraft(A321, ADMIN);

  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") return;
  assert.equal(result.aircraft.registration, "VN-A321");
  assert.equal(result.aircraft.seats.length, 38);
  assert.deepEqual(
    await aircraftRepository.findById(result.aircraft.id),
    result.aircraft,
  );
  assert.deepEqual(audit.records, [
    {
      id: "audit-1",
      action: "AIRCRAFT_REGISTERED",
      actor: { type: "account", id: ADMIN.accountId },
      target: { type: "aircraft", id: result.aircraft.id },
      occurredAt: FIXED_TIME.toISOString(),
      metadata: { registration: "VN-A321", economySeats: 30, businessSeats: 8 },
    },
  ]);
});

test("a taken registration is duplicate and audits nothing", async () => {
  const { registerAircraft, audit } = createContext();

  await registerAircraft(A321, ADMIN);
  const result = await registerAircraft({ ...A321, registration: "VN-A321" }, ADMIN);

  assert.deepEqual(result, { outcome: "duplicate" });
  assert.equal(audit.records.length, 1);
});

test("an overlapping layout is rejected before anything is written", async () => {
  const { registerAircraft, aircraftRepository, audit } = createContext();

  const result = await registerAircraft(
    {
      ...A321,
      seatLayout: {
        cabins: [
          { fareClass: "BUSINESS", fromRow: 1, toRow: 12, seatLetters: "ACDF" },
          { fareClass: "ECONOMY", fromRow: 12, toRow: 20, seatLetters: "ABCDEF" },
        ],
      },
    },
    ADMIN,
  );

  assert.equal(result.outcome, "validation_failed");
  assert.equal(
    await aircraftRepository.findById("c0ffee00-0000-4000-8000-000000000001"),
    undefined,
  );
  assert.equal(audit.records.length, 0);
});
