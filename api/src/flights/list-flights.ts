import {
  parsePageQuery,
  toPagination,
  type Pagination,
  type RawPageQuery,
} from "../pagination.js";
import type { Flight, ValidationIssue } from "../types.js";
import type { FlightRepository } from "./flight-repository.js";

export type RawListFlightsQuery = RawPageQuery;

export type ListFlightsSuccessResult = {
  outcome: "success";
  items: Flight[];
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
};

export function createListFlights(
  dependencies: ListFlightsDependencies,
): ListFlights {
  const { flightRepository } = dependencies;

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

    return {
      outcome: "success",
      items: repositoryResult.items,
      pagination: toPagination(pageQuery.value, repositoryResult.totalItems),
    };
  };
}
