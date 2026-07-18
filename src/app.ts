import express from "express";

import type { CreateFlight } from "./flights/create-flight.js";
import type { FlightRepository } from "./flights/flight-repository.js";
import type { ListFlights } from "./flights/list-flights.js";
import {
  errorHandler,
  notFoundHandler,
  sendApiError,
} from "./http-errors.js";

export type AppDependencies = {
  flightRepository: FlightRepository;
  createFlight: CreateFlight;
  listFlights: ListFlights;
};

export function createApp(dependencies: AppDependencies) {
  const { flightRepository, createFlight, listFlights } = dependencies;
  const app = express();

  app.use(express.json({ strict: false }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
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

  app.post("/api/flights", (req, res) => {
    const result = createFlight(req.body);

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
  app.use(errorHandler);

  return app;
}
