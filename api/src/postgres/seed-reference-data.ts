import "reflect-metadata";

import { validateRegisterAircraftInput } from "../aircraft/aircraft-validation.js";
import { createPostgresAircraftRepository } from "../aircraft/postgres/postgres-aircraft-repository.js";
import { validateRegisterAirportInput } from "../airports/airport-validation.js";
import { createPostgresAirportRepository } from "../airports/postgres/postgres-airport-repository.js";
import { parsePostgresConfig } from "./config.js";
import { createBookingDataSource } from "./data-source.js";

/**
 * Dev seed for reference data (Day 45): `npm run seed:reference`.
 * An entrypoint like run-migrations.ts, so it builds its own DataSource.
 *
 * Idempotent: an airport or aircraft that already exists comes back as
 * `duplicate` and is skipped, so it can run any number of times.
 *
 * Inputs go through the same validators as the API (normalization, IANA
 * check, layout limits). It calls repositories directly, not the use cases,
 * so it writes **no audit rows**: no account performs a seed.
 *
 * CXR and VN-A322 are deliberately absent: the Postman "Day 45" folder and
 * the DAY-45 e2e script create them and expect 201.
 */
const AIRPORTS = [
  // Vietnam — domestic network
  { code: "SGN", name: "Tan Son Nhat International", city: "Ho Chi Minh City", timeZone: "Asia/Ho_Chi_Minh" },
  { code: "HAN", name: "Noi Bai International", city: "Hanoi", timeZone: "Asia/Ho_Chi_Minh" },
  { code: "DAD", name: "Da Nang International", city: "Da Nang", timeZone: "Asia/Ho_Chi_Minh" },
  { code: "PQC", name: "Phu Quoc International", city: "Phu Quoc", timeZone: "Asia/Ho_Chi_Minh" },
  { code: "HPH", name: "Cat Bi International", city: "Hai Phong", timeZone: "Asia/Ho_Chi_Minh" },
  { code: "VCA", name: "Can Tho International", city: "Can Tho", timeZone: "Asia/Ho_Chi_Minh" },
  { code: "HUI", name: "Phu Bai International", city: "Hue", timeZone: "Asia/Ho_Chi_Minh" },
  { code: "DLI", name: "Lien Khuong", city: "Da Lat", timeZone: "Asia/Ho_Chi_Minh" },
  { code: "UIH", name: "Phu Cat", city: "Quy Nhon", timeZone: "Asia/Ho_Chi_Minh" },
  { code: "VDO", name: "Van Don International", city: "Quang Ninh", timeZone: "Asia/Ho_Chi_Minh" },
  { code: "BMV", name: "Buon Ma Thuot", city: "Buon Ma Thuot", timeZone: "Asia/Ho_Chi_Minh" },
  { code: "THD", name: "Tho Xuan", city: "Thanh Hoa", timeZone: "Asia/Ho_Chi_Minh" },
  // Asia — no daylight saving time
  { code: "BKK", name: "Suvarnabhumi", city: "Bangkok", timeZone: "Asia/Bangkok" },
  { code: "SIN", name: "Changi", city: "Singapore", timeZone: "Asia/Singapore" },
  { code: "KUL", name: "Kuala Lumpur International", city: "Kuala Lumpur", timeZone: "Asia/Kuala_Lumpur" },
  { code: "HKG", name: "Hong Kong International", city: "Hong Kong", timeZone: "Asia/Hong_Kong" },
  { code: "TPE", name: "Taoyuan International", city: "Taipei", timeZone: "Asia/Taipei" },
  { code: "ICN", name: "Incheon International", city: "Seoul", timeZone: "Asia/Seoul" },
  { code: "NRT", name: "Narita International", city: "Tokyo", timeZone: "Asia/Tokyo" },
  { code: "DXB", name: "Dubai International", city: "Dubai", timeZone: "Asia/Dubai" },
  // Daylight saving time: the offset changes during the year, which is why
  // the zone name is stored and never an offset (BR-REF-04).
  { code: "LHR", name: "Heathrow", city: "London", timeZone: "Europe/London" },
  { code: "CDG", name: "Charles de Gaulle", city: "Paris", timeZone: "Europe/Paris" },
  { code: "FRA", name: "Frankfurt", city: "Frankfurt", timeZone: "Europe/Berlin" },
  { code: "LAX", name: "Los Angeles International", city: "Los Angeles", timeZone: "America/Los_Angeles" },
  // Southern hemisphere: summer time runs October–April, opposite to Europe.
  { code: "SYD", name: "Kingsford Smith", city: "Sydney", timeZone: "Australia/Sydney" },
];

const AIRCRAFT = [
  {
    registration: "VN-A321",
    model: "Airbus A321",
    seatLayout: {
      cabins: [
        { fareClass: "BUSINESS", fromRow: 1, toRow: 2, seatLetters: "ACDF" },
        { fareClass: "ECONOMY", fromRow: 3, toRow: 30, seatLetters: "ABCDEF" },
      ],
    },
  },
  {
    registration: "VN-A861",
    model: "Boeing 787-9",
    seatLayout: {
      cabins: [
        { fareClass: "BUSINESS", fromRow: 1, toRow: 7, seatLetters: "ADGK" },
        { fareClass: "ECONOMY", fromRow: 10, toRow: 40, seatLetters: "ABCDEFGHK" },
      ],
    },
  },
  {
    registration: "VN-A323",
    model: "Airbus A321neo",
    seatLayout: {
      cabins: [
        { fareClass: "BUSINESS", fromRow: 1, toRow: 2, seatLetters: "ACDF" },
        { fareClass: "ECONOMY", fromRow: 3, toRow: 33, seatLetters: "ABCDEF" },
      ],
    },
  },
  {
    // No row 13: rows may skip numbers between cabins.
    registration: "VN-A632",
    model: "Airbus A321",
    seatLayout: {
      cabins: [
        { fareClass: "BUSINESS", fromRow: 1, toRow: 2, seatLetters: "ACDF" },
        { fareClass: "ECONOMY", fromRow: 3, toRow: 12, seatLetters: "ABCDEF" },
        { fareClass: "ECONOMY", fromRow: 14, toRow: 32, seatLetters: "ABCDEF" },
      ],
    },
  },
  {
    // Single-class layout: economy only.
    registration: "VN-A588",
    model: "Airbus A320neo",
    seatLayout: {
      cabins: [
        { fareClass: "ECONOMY", fromRow: 1, toRow: 30, seatLetters: "ABCDEF" },
      ],
    },
  },
  {
    registration: "VN-A868",
    model: "Boeing 787-10",
    seatLayout: {
      cabins: [
        { fareClass: "BUSINESS", fromRow: 1, toRow: 6, seatLetters: "ADGK" },
        { fareClass: "ECONOMY", fromRow: 10, toRow: 45, seatLetters: "ABCDEFGHK" },
      ],
    },
  },
  {
    registration: "VN-A899",
    model: "Airbus A350-900",
    seatLayout: {
      cabins: [
        { fareClass: "BUSINESS", fromRow: 1, toRow: 8, seatLetters: "ADGK" },
        { fareClass: "ECONOMY", fromRow: 10, toRow: 42, seatLetters: "ABCDEFGHK" },
      ],
    },
  },
  {
    // Regional turboprop: 2+2 seating, letters A C D F.
    registration: "VN-B210",
    model: "ATR 72-600",
    seatLayout: {
      cabins: [
        { fareClass: "ECONOMY", fromRow: 1, toRow: 17, seatLetters: "ACDF" },
      ],
    },
  },
];

const config = parsePostgresConfig(process.env);
const dataSource = createBookingDataSource(config);
await dataSource.initialize();

const airportRepository = createPostgresAirportRepository(dataSource);
const aircraftRepository = createPostgresAircraftRepository(dataSource);
const now = new Date().toISOString();

try {
  for (const input of AIRPORTS) {
    const validation = validateRegisterAirportInput(input);
    if (!validation.success) {
      throw new Error(`Invalid seed airport ${input.code}: ${JSON.stringify(validation.issues)}`);
    }

    const result = await airportRepository.create({
      id: crypto.randomUUID(),
      ...validation.value,
      createdAt: now,
    });
    console.log(JSON.stringify({ message: "seed_airport", code: validation.value.code, outcome: result.outcome }));
  }

  for (const input of AIRCRAFT) {
    const validation = validateRegisterAircraftInput(input);
    if (!validation.success) {
      throw new Error(`Invalid seed aircraft ${input.registration}: ${JSON.stringify(validation.issues)}`);
    }

    const result = await aircraftRepository.create({
      id: crypto.randomUUID(),
      ...validation.value,
      createdAt: now,
    });
    console.log(
      JSON.stringify({
        message: "seed_aircraft",
        registration: validation.value.registration,
        seats: validation.value.seats.length,
        outcome: result.outcome,
      }),
    );
  }
} finally {
  await dataSource.destroy();
}
