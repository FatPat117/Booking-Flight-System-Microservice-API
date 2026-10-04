import { runBookingRepositoryContract } from "./contracts/booking-repository.contract.js";
import {
  createInMemoryBookingRepository,
  createInMemoryFlightRepository,
  createInMemoryFlightStore,
} from "./fakes/in-memory.js";

runBookingRepositoryContract("in-memory", async () => {
  const flights = createInMemoryFlightStore();
  const flightRepository = createInMemoryFlightRepository(flights);

  return {
    repository: createInMemoryBookingRepository({ flights }),
    async insertFlight(flight) {
      await flightRepository.create(flight);
    },
  };
});
