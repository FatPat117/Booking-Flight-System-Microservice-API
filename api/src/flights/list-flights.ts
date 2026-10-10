import {
  parsePageQuery,
  toPagination,
  type Pagination,
  type RawPageQuery,
} from "../pagination.js";
import type { ValidationIssue } from "../types.js";
import type { FlightRepository } from "./flight-repository.js";
import { toFlightView, type FlightView } from "./flight-view.js";

export type RawListFlightsQuery = RawPageQuery;

export type ListFlightsSuccessResult = {
  outcome: "success";
  items: FlightView[];
  pagination: Pagination;
};

export type ListFlightsValidationFailure = {
  outcome: "validation_failed";
  issues: ValidationIssue[];
};

export type ListFlightsResult =
  | ListFlightsSuccessResult
  | ListFlightsValidationFailure;

export type ListFlights = (
  query: RawListFlightsQuery,
) => Promise<ListFlightsResult>;

type ListFlightsDependencies = {
  flightRepository: FlightRepository;
  getCurrentTime: () => Date;
};

export function createListFlights(
  dependencies: ListFlightsDependencies,
): ListFlights {
  const { flightRepository, getCurrentTime } = dependencies;

  return async function listFlights(
    rawQuery: RawListFlightsQuery,
  ): Promise<ListFlightsResult> {
    const pageQuery = parsePageQuery(rawQuery);

    if (!pageQuery.success) {
      return { outcome: "validation_failed", issues: pageQuery.issues };
    }

    const repositoryResult = await flightRepository.findPage({
      limit: pageQuery.value.limit,
      offset: pageQuery.value.offset,
    });

    // One clock reading for the whole page, so two flights on it cannot
    // disagree about "now".
    const now = getCurrentTime();

    return {
      outcome: "success",
      items: repositoryResult.items.map((flight) => toFlightView(flight, now)),
      pagination: toPagination(pageQuery.value, repositoryResult.totalItems),
    };
  };
}
