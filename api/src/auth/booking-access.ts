import type { BookingAccessScope } from "../bookings/booking-repository.js";
import type { AuthenticatedUser } from "../observability/request-context.js";
import type { Actor } from "../types.js";

/**
 * The single place that turns a verified JWT into booking access
 * (BR-AUTH-02/03). Every booking route uses it, so "admins see every booking"
 * is decided here once rather than in a ternary per handler.
 *
 * JWT `sub` is the Identity account id: `userId` on AuthenticatedUser,
 * `accountId` in this service's domain language (docs/product/scope.md).
 */
export function toBookingAccessScope(
  user: AuthenticatedUser,
): BookingAccessScope {
  return user.role === "admin"
    ? { kind: "admin" }
    : { kind: "owner", accountId: user.userId };
}

export function toActor(user: AuthenticatedUser): Actor {
  return { accountId: user.userId };
}
