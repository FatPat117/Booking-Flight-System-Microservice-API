import express from "express";

import { createApiKeyAuthMiddleware } from "./auth/api-key-auth.js";
import type { CancelBooking } from "./bookings/cancel-booking.js";
import type { CreateBooking } from "./bookings/create-booking.js";
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
import { createRequestObservabilityMiddleware } from "./observability/request-observability.js";

export type AppDependencies = {
  flightRepository: FlightRepository;
  createFlight: CreateFlight;
  createBooking: CreateBooking;
  cancelBooking: CancelBooking;
  listFlights: ListFlights;
  logger: Logger;
  healthChecks: HealthChecks;
  adminApiKey: string;
};

export function createApp(dependencies: AppDependencies) {
  const {
    flightRepository,
    createFlight,
    createBooking,
    cancelBooking,
    listFlights,
    logger,
    healthChecks,
    adminApiKey,
  } = dependencies;
  const app = express();

  const requireAdminApiKey = createApiKeyAuthMiddleware({
    adminApiKey,
  });

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

  app.get("/ready", (_request, response) => {
    const readiness = healthChecks.checkReadiness();
    const statusCode = readiness.status === "ok" ? 200 : 503;

    return response.status(statusCode).json(readiness);
  });

  app.get("/api/flights", (req, res) => {
    const result = listFlights({
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

  app.get("/api/flights/:id", (req, res) => {
    const { id } = req.params;
    const flight = flightRepository.findById(id);

    if (!flight) {
      return sendApiError(res, 404, {
        code: "FLIGHT_NOT_FOUND",
        message: "Flight was not found",
      });
    }

    return res.status(200).json(flight);
  });

  app.post("/api/flights", requireAdminApiKey, async (req, res) => {
    const result = await createFlight(req.body);

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
  });

  app.post("/api/flights/:flightId/bookings", async (req, res) => {
    const result = await createBooking(req.params.flightId, req.body);

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

    res.setHeader(
      "Location",
      `/api/flights/${result.booking.flightId}/bookings/${result.booking.id}`,
    );
    return res.status(201).json(result.booking);
  });

  // 409 for already-cancelled: resource state conflicts with a second cancel.
  // Chosen over idempotent 204 so clients can tell "first cancel" from "repeat".
  app.delete("/api/bookings/:id", async (req, res) => {
    const result = await cancelBooking(req.params.id);

    if (result.outcome === "validation_failed") {
      return sendApiError(res, 422, {
        code: "VALIDATION_FAILED",
        message: "Request contains invalid booking id",
        details: result.issues,
      });
    }

    if (result.outcome === "not-found") {
      return sendApiError(res, 404, {
        code: "BOOKING_NOT_FOUND",
        message: "Booking was not found",
      });
    }

    if (result.outcome === "already-cancelled") {
      return sendApiError(res, 409, {
        code: "BOOKING_ALREADY_CANCELLED",
        message: "Booking was already cancelled",
      });
    }

    return res.status(204).send();
  });

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
