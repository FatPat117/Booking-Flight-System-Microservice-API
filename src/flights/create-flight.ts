import type { Flight, ValidationIssue } from "../types.js";
import type { FlightRepository } from "./flight-repository.js";
import { validateCreateFlightInput } from "./flight-validation.js";

export type CreateFlightResult =
  | { outcome: "created"; flight: Flight }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | { outcome: "duplicate" };

export type CreateFlight = (input: unknown) => CreateFlightResult;

type CreateFlightDependencies = {
  flightRepository: FlightRepository;
  generateId: () => string;
};

/**
 * Application use case: create a flight from untrusted input.
 * No Express, HTTP status, or SQLite knowledge.
 */
export function createCreateFlight(
  dependencies: CreateFlightDependencies,
): CreateFlight {
  const { flightRepository, generateId } = dependencies;

  return (input: unknown): CreateFlightResult => {
    const validation = validateCreateFlightInput(input);

    if (!validation.success) {
      return {
        outcome: "validation_failed",
        issues: validation.issues,
      };
    }

    const validated = validation.value;

    const flight: Flight = {
      id: generateId(),
      flightNumber: validated.flightNumber,
      origin: validated.origin,
      destination: validated.destination,
      departureAt: validated.departureAt,
      arrivalAt: validated.arrivalAt,
      priceInCents: validated.priceInCents,
      currency: validated.currency,
      availableSeats: validated.availableSeats,
    };

    const persistResult = flightRepository.create(flight);

    if (persistResult.outcome === "duplicate") {
      return { outcome: "duplicate" };
    }

    return { outcome: "created", flight };
  };
}
