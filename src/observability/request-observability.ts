import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { NextFunction, Request, Response } from "express";

import type { Logger } from "./logger.js";
import { runWithRequestContext } from "./request-context.js";

const REQUEST_ID_HEADER = "x-request-id";

function getHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function isUsableRequestId(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return false;
  }

  // Guardrail against oversized log/header values.
  return trimmed.length <= 128;
}

function resolveRequestId(request: Request): string {
  const incoming = getHeaderValue(request.headers[REQUEST_ID_HEADER]);

  if (isUsableRequestId(incoming)) {
    return incoming.trim();
  }

  return randomUUID();
}

export function createRequestObservabilityMiddleware(logger: Logger) {
  return function requestObservability(
    request: Request,
    response: Response,
    next: NextFunction,
  ) {
    const requestId = resolveRequestId(request);
    const startedAt = performance.now();

    response.setHeader(REQUEST_ID_HEADER, requestId);

    runWithRequestContext({ requestId }, () => {
      logger.info("request_started", {
        requestId,
        method: request.method,
        path: request.originalUrl,
      });

      response.on("finish", () => {
        const durationMs =
          Math.round((performance.now() - startedAt) * 100) / 100;

        logger.info("request_finished", {
          requestId,
          method: request.method,
          path: request.originalUrl,
          statusCode: response.statusCode,
          durationMs,
        });
      });

      next();
    });
  };
}
