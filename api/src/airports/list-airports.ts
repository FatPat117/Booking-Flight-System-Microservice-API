import {
  parsePageQuery,
  toPagination,
  type Pagination,
  type RawPageQuery,
} from "../pagination.js";
import type { ValidationIssue } from "../types.js";
import type { Airport, AirportRepository } from "./airport-repository.js";

export type ListAirportsResult =
  | { outcome: "success"; items: Airport[]; pagination: Pagination }
  | { outcome: "validation_failed"; issues: ValidationIssue[] };

/** US-REF-03: public, ordered by code, same pagination as flights. */
export type ListAirports = (
  rawQuery: RawPageQuery,
) => Promise<ListAirportsResult>;

export function createListAirports(dependencies: {
  airportRepository: AirportRepository;
}): ListAirports {
  const { airportRepository } = dependencies;

  return async (rawQuery) => {
    const pageQuery = parsePageQuery(rawQuery);

    if (!pageQuery.success) {
      return { outcome: "validation_failed", issues: pageQuery.issues };
    }

    const page = await airportRepository.findPage({
      limit: pageQuery.value.limit,
      offset: pageQuery.value.offset,
    });

    return {
      outcome: "success",
      items: page.items,
      pagination: toPagination(pageQuery.value, page.totalItems),
    };
  };
}
