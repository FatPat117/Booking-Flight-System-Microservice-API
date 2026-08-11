import express from "express";

import { createApiKeyAuthMiddleware } from "./auth/api-key-auth.js";
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
  listFlights: ListFlights;
  logger: Logger;
  healthChecks: HealthChecks;
  adminApiKey: string;
};

export function createApp(dependencies: AppDependencies) {
  const {
    flightRepository,
    createFlight,
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

  app.use(notFoundHandler);
  app.use(createErrorHandler(logger));

  return app;
}
