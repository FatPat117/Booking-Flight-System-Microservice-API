import type { NextFunction, Request, Response } from "express";

import type { Logger } from "./observability/logger.js";
import { getRequestContext } from "./observability/request-context.js";
import type { ApiErrorDescriptor } from "./types.js";

export function sendApiError(
  response: Response,
  status: number,
  error: ApiErrorDescriptor,
) {
  return response.status(status).json({ error });
}

function isMalformedJsonError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { type?: unknown; status?: unknown };
  // JSON Parser Error returns a 400 status code with a type of "entity.parse.failed"
  return (
    candidate.type === "entity.parse.failed" && candidate.status === 400
  );
}

function getErrorInfo(error: unknown) {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      stack: error.stack,
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: String(error),
  };
}

function resolveRequestId(response: Response): string | undefined {
  const fromContext = getRequestContext()?.requestId;
  if (fromContext) {
    return fromContext;
  }

  const header = response.getHeader("x-request-id");
  if (typeof header === "string") {
    return header;
  }
  if (Array.isArray(header) && typeof header[0] === "string") {
    return header[0];
  }

  return undefined;
}

export function notFoundHandler(_request: Request, response: Response) {
  return sendApiError(response, 404, {
    code: "ROUTE_NOT_FOUND",
    message: "The requested route was not found",
  });
}

export function createErrorHandler(logger: Logger) {
  return function errorHandler(
    error: unknown,
    _request: Request,
    response: Response,
    next: NextFunction,
  ) {
    // If the response headers have already been sent, pass the error to the next middleware
    if (response.headersSent) {
      return next(error);
    }

    if (isMalformedJsonError(error)) {
      return sendApiError(response, 400, {
        code: "MALFORMED_JSON",
        message: "Request body contains invalid JSON",
      });
    }

    const requestId = resolveRequestId(response);

    logger.error("unexpected_error", {
      ...(requestId ? { requestId } : {}),
      ...getErrorInfo(error),
    });

    return sendApiError(response, 500, {
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected error occurred",
    });
  };
}
