import express, { type Request } from "express";

import { toActor, toBookingAccessScope } from "./auth/booking-access.js";
import { requireRole } from "./auth/require-role.js";
import { createVerifyJwtMiddleware } from "./auth/verify-jwt.js";
import type { CancelBooking } from "./bookings/cancel-booking.js";
import type { CreateBooking } from "./bookings/create-booking.js";
import type { GetBooking } from "./bookings/get-booking.js";
import type { ListBookings } from "./bookings/list-bookings.js";
import type { CreateFlight } from "./flights/create-flight.js";
import type { FlightRepository } from "./flights/flight-repository.js";
import type { ListFlights } from "./flights/list-flights.js";
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
  flightRepository: FlightRepository;
  createFlight: CreateFlight;
  createBooking: CreateBooking;
  cancelBooking: CancelBooking;
  getBooking: GetBooking;
  listBookings: ListBookings;
  listFlights: ListFlights;
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
    flightRepository,
    createFlight,
    createBooking,
    cancelBooking,
    getBooking,
    listBookings,
    listFlights,
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
    const { id } = req.params;
    const flight = await flightRepository.findById(id);

    if (!flight) {
      return sendApiError(res, 404, {
        code: "FLIGHT_NOT_FOUND",
        message: "Flight was not found",
      });
    }

    return res.status(200).json(flight);
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

      res.setHeader("Location", `/api/flights/${result.flight.id}`);
      return res.status(201).json(result.flight);
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

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
