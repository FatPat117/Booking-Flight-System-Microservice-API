import { parseSeatPosition } from "../src/aircraft/seat-position.js";
import { runFlightSearchContract } from "./contracts/flight-search.contract.js";
import {
  createInMemoryFlightRepository,
  createInMemoryFlightSearch,
  createInMemoryFlightStore,
} from "./fakes/in-memory.js";
import { TEST_AIRPORTS } from "./fixtures/flights.js";

runFlightSearchContract("in-memory", async () => {
  const store = createInMemoryFlightStore();
  const flights = createInMemoryFlightRepository(store);

  return {
    search: createInMemoryFlightSearch(store, TEST_AIRPORTS),
    async addFlight(flight) {
      const result = await flights.create(flight);
      if (result.outcome !== "created") throw new Error(`fixture flight not created: ${result.outcome}`);
    },
    async occupy(flightId, codes) {
      const bookingId = crypto.randomUUID();
      for (const code of codes) {
        const position = parseSeatPosition(code);
        const seat = store.seats
          .get(flightId)
          ?.find((candidate) => candidate.position.row === position?.row && candidate.position.letter === position?.letter);
        if (seat === undefined) throw new Error(`no seat ${code}`);
        seat.status = "BOOKED";
        seat.bookingId = bookingId;
      }
    },
  };
});
