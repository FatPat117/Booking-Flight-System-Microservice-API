import type { FareClass } from "../aircraft/seat-layout.js";
import { formatSeatPosition } from "../aircraft/seat-position.js";
import { type FlightFares, isUuid } from "../types.js";
import type {
  FlightRepository,
  FlightSeat,
  FlightSeatStatus,
} from "./flight-repository.js";

/** Every field a seat map may show — nothing about who holds a seat. */
export type SeatMapSeat = {
  code: string;
  fareClass: FareClass;
  status: FlightSeatStatus;
};

export type SeatMapRow = {
  row: number;
  seats: SeatMapSeat[];
};

/**
 * `fares` once, not on every seat: a seat's price is its class's fare, and
 * repeating it per seat would only make 180 copies of two numbers.
 */
export type SeatMap = {
  flightId: string;
  fares: FlightFares;
  rows: SeatMapRow[];
};

export type GetFlightSeatMapResult =
  | { outcome: "found"; seatMap: SeatMap }
  | { outcome: "not-found" };

export type GetFlightSeatMap = (
  flightId: string,
) => Promise<GetFlightSeatMapResult>;

/** Seats arrive in (row, letter) order, so each row is one consecutive run. */
function groupByRow(seats: FlightSeat[]): SeatMapRow[] {
  const rows: SeatMapRow[] = [];

  for (const seat of seats) {
    const seatView: SeatMapSeat = {
      code: formatSeatPosition(seat.position),
      fareClass: seat.fareClass,
      status: seat.status,
    };
    const current = rows.at(-1);

    if (current?.row === seat.position.row) {
      current.seats.push(seatView);
    } else {
      rows.push({ row: seat.position.row, seats: [seatView] });
    }
  }

  return rows;
}

/**
 * The public seat map of one flight (no auth, like the flight itself): which
 * seats exist, their fare class and its price, and whether they are still free. A
 * malformed id is not-found, like getFlight.
 */
export function createGetFlightSeatMap(dependencies: {
  flightRepository: FlightRepository;
}): GetFlightSeatMap {
  const { flightRepository } = dependencies;

  return async (flightId) => {
    if (!isUuid(flightId)) {
      return { outcome: "not-found" };
    }

    const [flight, seats] = await Promise.all([
      flightRepository.findById(flightId),
      flightRepository.findSeats(flightId),
    ]);

    return flight === undefined || seats === undefined
      ? { outcome: "not-found" }
      : {
          outcome: "found",
          seatMap: { flightId, fares: flight.fares, rows: groupByRow(seats) },
        };
  };
}
