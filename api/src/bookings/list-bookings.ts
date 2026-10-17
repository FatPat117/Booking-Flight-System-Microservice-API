import {
  parsePageQuery,
  toPagination,
  type Pagination,
  type RawPageQuery,
} from "../pagination.js";
import type { ValidationIssue } from "../types.js";
import { withEffectiveStatus } from "./booking-lifecycle.js";
import type {
  Booking,
  BookingAccessScope,
  BookingRepository,
} from "./booking-repository.js";

export type ListBookingsResult =
  | { outcome: "success"; items: Booking[]; pagination: Pagination }
  | { outcome: "validation_failed"; issues: ValidationIssue[] };

/**
 * Bookings visible from `scope`, newest first: an owner sees their own
 * (US-BOOK-02), an admin sees every account's (BR-AUTH-03). Lapsed holds
 * read EXPIRED (Decision 12), all against one `now` per page.
 */
export type ListBookings = (
  scope: BookingAccessScope,
  rawQuery: RawPageQuery,
) => Promise<ListBookingsResult>;

export function createListBookings(dependencies: {
  bookingRepository: BookingRepository;
  getCurrentTime: () => Date;
}): ListBookings {
  const { bookingRepository, getCurrentTime } = dependencies;

  return async (scope, rawQuery) => {
    const pageQuery = parsePageQuery(rawQuery);

    if (!pageQuery.success) {
      return { outcome: "validation_failed", issues: pageQuery.issues };
    }

    const page = await bookingRepository.findPage(scope, {
      limit: pageQuery.value.limit,
      offset: pageQuery.value.offset,
    });

    const now = getCurrentTime();

    return {
      outcome: "success",
      items: page.items.map((booking) => withEffectiveStatus(booking, now)),
      pagination: toPagination(pageQuery.value, page.totalItems),
    };
  };
}
