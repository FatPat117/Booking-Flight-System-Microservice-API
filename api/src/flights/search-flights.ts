import type { ValidationIssue } from "../types.js";
import { localTimesOf, type LocalTimes } from "./flight-details-view.js";
import type { FlightSearch, FlightSearchResult } from "./flight-search.js";
import { validateFlightSearchQuery, type RawFlightSearchQuery } from "./flight-search-validation.js";
import { decodeSearchCursor, encodeSearchCursor } from "./search-cursor.js";

/** A search result as the screen shows it: with local times (Decision 17). */
export type FlightSearchItem = FlightSearchResult & LocalTimes;

export type SearchFlightsResult =
  | {
      outcome: "success";
      items: readonly FlightSearchItem[];
      page: { hasNextPage: boolean; nextCursor: string | null };
    }
  | { outcome: "validation_failed"; issues: ValidationIssue[] }
  | { outcome: "invalid_cursor" };

export type SearchFlights = (query: RawFlightSearchQuery) => Promise<SearchFlightsResult>;

type SearchFlightsDependencies = {
  flightSearch: FlightSearch;
  getCurrentTime: () => Date;
};

/**
 * US-FLT-04 (Decision 17): validate, continue after the cursor's key if
 * there is one, read one page, and hand back a cursor for the next. A
 * validation problem wins over a bad cursor: the cursor can only be judged
 * against a valid search.
 */
export function createSearchFlights(dependencies: SearchFlightsDependencies): SearchFlights {
  const { flightSearch, getCurrentTime } = dependencies;

  return async function searchFlights(raw) {
    const validated = validateFlightSearchQuery(raw);
    if (!validated.success) {
      return { outcome: "validation_failed", issues: validated.issues };
    }
    const { query, cursor } = validated.value;

    let after;
    if (cursor !== undefined) {
      const decoded = decodeSearchCursor(cursor, query);
      if (!decoded.success) {
        return { outcome: "invalid_cursor" };
      }
      after = decoded.key;
    }

    const page = await flightSearch.search(
      after === undefined ? query : { ...query, after },
      getCurrentTime(),
    );

    const last = page.items.at(-1);
    return {
      outcome: "success",
      items: page.items.map((item) => ({
        ...item,
        ...localTimesOf(item.departureAt, item.origin.timeZone, item.arrivalAt, item.destination.timeZone),
      })),
      page: {
        hasNextPage: page.hasNextPage,
        nextCursor:
          page.hasNextPage && last !== undefined
            ? encodeSearchCursor(
                { departureAt: last.departureAt, id: last.id, lowestFare: last.lowestFare.amount },
                query,
              )
            : null,
      },
    };
  };
}
