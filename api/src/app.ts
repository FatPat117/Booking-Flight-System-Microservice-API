import express, { type Request } from "express";

import type { RegisterAircraft } from "./aircraft/register-aircraft.js";
import { countSeatsByFareClass } from "./aircraft/seat-layout.js";
import type { ListAirports } from "./airports/list-airports.js";
import type { RegisterAirport } from "./airports/register-airport.js";
import { toActor, toBookingAccessScope } from "./auth/booking-access.js";
import { requireRole } from "./auth/require-role.js";
import { createVerifyJwtMiddleware } from "./auth/verify-jwt.js";
import type { CancelBooking } from "./bookings/cancel-booking.js";
import type { CreateBooking } from "./bookings/create-booking.js";
import type { GetBooking } from "./bookings/get-booking.js";
import type { ListBookings } from "./bookings/list-bookings.js";
import type { CreateFlight } from "./flights/create-flight.js";
import type { GetFlight } from "./flights/get-flight.js";
import type { ListFlights } from "./flights/list-flights.js";
import type { OpenFlight } from "./flights/open-flight.js";
import type { HealthChecks } from "./health/health-checks.js";
import {
  createErrorHandler,
  notFoundHandler,
  sendApiError,
} from "./http-errors.js";
import type { Logger } from "./observability/logger.js";
import {
  getAuthenticatedUser,
  type AuthenticatedUser,
} from "./observability/request-context.js";
import { createRequestObservabilityMiddleware } from "./observability/request-observability.js";

export type AppDependencies = {
  getFlight: GetFlight;
  createFlight: CreateFlight;
  openFlight: OpenFlight;
  createBooking: CreateBooking;
  cancelBooking: CancelBooking;
  getBooking: GetBooking;
  listBookings: ListBookings;
  listFlights: ListFlights;
  registerAirport: RegisterAirport;
  listAirports: ListAirports;
  registerAircraft: RegisterAircraft;
  logger: Logger;
  healthChecks: HealthChecks;
  jwtSecret: string;
};

/**
 * For handlers behind requireJwt only. Missing here means the middleware
 * chain is wrong — a programmer error, so it throws (→ generic 500) instead
 * of quietly treating the request as anonymous.
 */
function currentUser(): AuthenticatedUser {
  const user = getAuthenticatedUser();

  if (user === undefined) {
    throw new Error("Route requires requireJwt to run first");
  }

  return user;
}

const BOOKING_NOT_FOUND = {
  code: "BOOKING_NOT_FOUND",
  message: "Booking was not found",
} as const;

export function createApp(dependencies: AppDependencies) {
  const {
    getFlight,
    createFlight,
    openFlight,
    createBooking,
    cancelBooking,
    getBooking,
    listBookings,
    listFlights,
    registerAirport,
    listAirports,
    registerAircraft,
    logger,
    healthChecks,
    jwtSecret,
  } = dependencies;
  const app = express();

  const requireJwt = createVerifyJwtMiddleware({ jwtSecret });

  app.use(createRequestObservabilityMiddleware(logger));
  app.use(express.json({ strict: false }));

  app.get("/live", (_request, response) => {
    return response.status(200).json({
      status: "ok",
    });
  });

  app.get("/health", (_request, response) => {
    return response.status(200).json({
      status: "ok",
    });
  });

  app.get("/ready", async (_request, response) => {
    const readiness = await healthChecks.checkReadiness();
    const statusCode = readiness.status === "ok" ? 200 : 503;

    return response.status(statusCode).json(readiness);
  });

  app.get("/api/whoami", requireJwt, (_request, response) => {
    const user = getAuthenticatedUser();

    return response.status(200).json({
      userId: user?.userId,
      email: user?.email,
      role: user?.role,
    });
  });

  app.get("/api/flights", async (req, res) => {
    const result = await listFlights({
      page: req.query.page,
      pageSize: req.query.pageSize,
    });

    if (result.outcome === "validation_failed") {
      return sendApiError(res, 422, {
        code: "VALIDATION_FAILED",
        message: "Request contains invalid pagination parameters",
        details: result.issues,
      });
    }

    return res.status(200).json({
      items: result.items,
      pagination: result.pagination,
    });
  });

  app.get("/api/flights/:id", async (req, res) => {
    const result = await getFlight(req.params.id);

    if (result.outcome === "not-found") {
      return sendApiError(res, 404, {
        code: "FLIGHT_NOT_FOUND",
        message: "Flight was not found",
      });
    }

    return res.status(200).json(result.flight);
  });

  app.post(
    "/api/flights",
    requireJwt,
    requireRole("admin"),
    async (req, res) => {
      const result = await createFlight(req.body, toActor(currentUser()));

      if (result.outcome === "validation_failed") {
        return sendApiError(res, 422, {
          code: "VALIDATION_FAILED",
          message: "Request contains invalid flight data",
          details: result.issues,
        });
      }

      if (result.outcome === "duplicate") {
        return sendApiError(res, 409, {
          code: "FLIGHT_ALREADY_EXISTS",
          message:
            "A flight with the same flight number and departure time already exists",
        });
      }

      if (result.outcome === "aircraft-unavailable") {
        return sendApiError(res, 409, {
          code: "AIRCRAFT_UNAVAILABLE",
          message:
            "The aircraft already operates a flight in this window (including 45 min turnaround)",
        });
      }

      res.setHeader("Location", `/api/flights/${result.flight.id}`);
      return res.status(201).json(result.flight);
    },
  );

  // A command, not a PATCH of `status`: the only status a person may set
  // today is OPEN, and the lifecycle decides from where (US-FLT-02).
  app.post(
    "/api/flights/:id/open",
    requireJwt,
    requireRole("admin"),
    async (req: Request<{ id: string }>, res) => {
      const result = await openFlight(req.params.id, toActor(currentUser()));

      if (result.outcome === "not-found") {
        return sendApiError(res, 404, {
          code: "FLIGHT_NOT_FOUND",
          message: "Flight was not found",
        });
      }

      if (result.outcome === "invalid-status") {
        return sendApiError(res, 409, {
          code: "INVALID_FLIGHT_STATUS",
          message: `Cannot open a flight that is ${result.currentStatus}`,
          details: [
            {
              field: "status",
              code: result.reason,
              message:
                result.reason === "DEPARTURE_TOO_SOON"
                  ? "Departure is 1 hour away or less"
                  : `${result.currentStatus} → OPEN is not allowed`,
            },
          ],
        });
      }

      // Lost the compare-and-set to a concurrent change.
      if (result.outcome === "status-changed") {
        return sendApiError(res, 409, {
          code: "FLIGHT_STATUS_CHANGED",
          message: `The flight was changed meanwhile and is now ${result.currentStatus}`,
        });
      }

      return res.status(200).json(result.flight);
    },
  );

  // Admins do not book on someone's behalf (BR-AUTH-03), hence role `user`.
  app.post(
    "/api/flights/:flightId/bookings",
    requireJwt,
    requireRole("user"),
    async (req: Request<{ flightId: string }>, res) => {
      const result = await createBooking(
        req.params.flightId,
        req.body,
        toActor(currentUser()),
      );

      if (result.outcome === "validation_failed") {
        return sendApiError(res, 422, {
          code: "VALIDATION_FAILED",
          message: "Request contains invalid booking data",
          details: result.issues,
        });
      }

      if (result.outcome === "flight-not-found") {
        return sendApiError(res, 404, {
          code: "FLIGHT_NOT_FOUND",
          message: "Flight was not found",
        });
      }

      if (result.outcome === "sold-out") {
        return sendApiError(res, 409, {
          code: "FLIGHT_SOLD_OUT",
          message: "No seats available for this flight",
        });
      }

      // BR-FLT-06: not opened yet, cancelled, or within 1 hour of departure.
      if (result.outcome === "sales-closed") {
        return sendApiError(res, 409, {
          code: "SALES_CLOSED",
          message: "This flight is not open for sale",
        });
      }

      res.setHeader("Location", `/api/bookings/${result.booking.id}`);
      return res.status(201).json(result.booking);
    },
  );

  app.get("/api/bookings", requireJwt, async (req, res) => {
    const result = await listBookings(toBookingAccessScope(currentUser()), {
      page: req.query.page,
      pageSize: req.query.pageSize,
    });

    if (result.outcome === "validation_failed") {
      return sendApiError(res, 422, {
        code: "VALIDATION_FAILED",
        message: "Request contains invalid pagination parameters",
        details: result.issues,
      });
    }

    return res.status(200).json({
      items: result.items,
      pagination: result.pagination,
    });
  });

  // Another account's booking answers exactly like a missing one (BR-AUTH-02).
  app.get(
    "/api/bookings/:id",
    requireJwt,
    async (req: Request<{ id: string }>, res) => {
      const result = await getBooking(
        req.params.id,
        toBookingAccessScope(currentUser()),
      );

      if (result.outcome === "not-found") {
        return sendApiError(res, 404, BOOKING_NOT_FOUND);
      }

      return res.status(200).json(result.booking);
    },
  );

  // 409 for already-cancelled: resource state conflicts with a second cancel.
  // Chosen over idempotent 204 so clients can tell "first cancel" from "repeat".
  // Admins cancel only through flight cancellation (permission matrix), hence
  // role `user`.
  app.delete(
    "/api/bookings/:id",
    requireJwt,
    requireRole("user"),
    async (req: Request<{ id: string }>, res) => {
      const user = currentUser();
      const result = await cancelBooking(
        req.params.id,
        toBookingAccessScope(user),
        toActor(user),
      );

      if (result.outcome === "not-found") {
        return sendApiError(res, 404, BOOKING_NOT_FOUND);
      }

      if (result.outcome === "already-cancelled") {
        return sendApiError(res, 409, {
          code: "BOOKING_ALREADY_CANCELLED",
          message: "Booking was already cancelled",
        });
      }

      return res.status(204).send();
    },
  );

  // Reference data (Day 45). No Location header: there is no GET-by-id
  // route for an airport or aircraft (no user story asks for one).
  app.get("/api/airports", async (req, res) => {
    const result = await listAirports({
      page: req.query.page,
      pageSize: req.query.pageSize,
    });

    if (result.outcome === "validation_failed") {
      return sendApiError(res, 422, {
        code: "VALIDATION_FAILED",
        message: "Request contains invalid pagination parameters",
        details: result.issues,
      });
    }

    return res.status(200).json({
      items: result.items,
      pagination: result.pagination,
    });
  });

  app.post(
    "/api/airports",
    requireJwt,
    requireRole("admin"),
    async (req, res) => {
      const result = await registerAirport(req.body, toActor(currentUser()));

      if (result.outcome === "validation_failed") {
        return sendApiError(res, 422, {
          code: "VALIDATION_FAILED",
          message: "Request contains invalid airport data",
          details: result.issues,
        });
      }

      if (result.outcome === "duplicate") {
        return sendApiError(res, 409, {
          code: "AIRPORT_ALREADY_EXISTS",
          message: "An airport with this code already exists",
        });
      }

      return res.status(201).json(result.airport);
    },
  );

  app.post(
    "/api/aircraft",
    requireJwt,
    requireRole("admin"),
    async (req, res) => {
      const result = await registerAircraft(req.body, toActor(currentUser()));

      if (result.outcome === "validation_failed") {
        return sendApiError(res, 422, {
          code: "VALIDATION_FAILED",
          message: "Request contains invalid aircraft data",
          details: result.issues,
        });
      }

      if (result.outcome === "duplicate") {
        return sendApiError(res, 409, {
          code: "AIRCRAFT_ALREADY_EXISTS",
          message: "An aircraft with this registration already exists",
        });
      }

      const { id, registration, model, createdAt, seats } = result.aircraft;

      // Seat counts, not the expanded seats: the client sent the compact
      // layout and the seat map belongs to flights (US-SEAT-01).
      return res.status(201).json({
        id,
        registration,
        model,
        createdAt,
        seatCount: seats.length,
        seatsByFareClass: countSeatsByFareClass(seats),
      });
    },
  );

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
