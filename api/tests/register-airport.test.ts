import assert from "node:assert/strict";
import test from "node:test";

import { createRegisterAirport } from "../src/airports/register-airport.js";
import {
  createInMemoryAirportRepository,
  createInMemoryAuditRecorder,
  createInMemoryTransactionRunner,
} from "./fakes/in-memory.js";

const FIXED_TIME = new Date("2026-10-10T00:00:00.000Z");
const ADMIN = { accountId: "aaaaaaaa-0000-4000-8000-000000000001" };
const DAD = {
  code: "dad",
  name: "Da Nang International",
  city: "Da Nang",
  timeZone: "Asia/Ho_Chi_Minh",
};

function createContext() {
  const airportRepository = createInMemoryAirportRepository();
  const audit = createInMemoryAuditRecorder();
  let nextId = 0;

  const registerAirport = createRegisterAirport({
    airportRepository,
    auditRecorder: audit,
    transactionRunner: createInMemoryTransactionRunner(),
    generateId: () => `airport-${(nextId += 1)}`,
    generateAuditId: () => "audit-1",
    getRequestId: () => "req-1",
    getCurrentTime: () => FIXED_TIME,
  });

  return { registerAirport, airportRepository, audit };
}

test("a valid airport is created with a normalized code and audited with the admin account", async () => {
  const { registerAirport, airportRepository, audit } = createContext();

  const result = await registerAirport(DAD, ADMIN);

  const airport = {
    id: "airport-1",
    code: "DAD",
    name: "Da Nang International",
    city: "Da Nang",
    timeZone: "Asia/Ho_Chi_Minh",
    createdAt: FIXED_TIME.toISOString(),
  };
  assert.deepEqual(result, { outcome: "created", airport });
  assert.deepEqual(
    (await airportRepository.findPage({ limit: 10, offset: 0 })).items,
    [airport],
  );
  assert.deepEqual(audit.records, [
    {
      id: "audit-1",
      action: "AIRPORT_REGISTERED",
      actor: { type: "account", id: ADMIN.accountId },
      target: { type: "airport", id: "airport-1" },
      requestId: "req-1",
      occurredAt: FIXED_TIME.toISOString(),
      metadata: { code: "DAD", timeZone: "Asia/Ho_Chi_Minh" },
    },
  ]);
});

test("a code taken in another case is duplicate and audits nothing (US-REF-01)", async () => {
  const { registerAirport, audit } = createContext();

  await registerAirport({ ...DAD, code: "DAD" }, ADMIN);
  const result = await registerAirport(DAD, ADMIN);

  assert.deepEqual(result, { outcome: "duplicate" });
  assert.equal(audit.records.length, 1);
});

test("invalid input writes nothing", async () => {
  const { registerAirport, airportRepository, audit } = createContext();

  const result = await registerAirport(
    { ...DAD, timeZone: "Asia/Not_A_Zone" },
    ADMIN,
  );

  assert.equal(result.outcome, "validation_failed");
  assert.equal(
    (await airportRepository.findPage({ limit: 10, offset: 0 })).totalItems,
    0,
  );
  assert.equal(audit.records.length, 0);
});
