import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import { sendApiError } from "../http-errors.js";
import { setAuthenticatedUser } from "../observability/request-context.js";

export type VerifyJwtOptions = {
  jwtSecret: string;
};

const AUTHORIZATION_HEADER = "authorization";
const BEARER_PREFIX = "Bearer ";

function getHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

function extractBearerToken(
  authorizationHeader: string | undefined,
): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }

  if (!authorizationHeader.startsWith(BEARER_PREFIX)) {
    return undefined;
  }

  const token = authorizationHeader.slice(BEARER_PREFIX.length).trim();

  if (token.length === 0) {
    return undefined;
  }

  return token;
}

function sendUnauthorized(
  response: Response,
  code: string,
  message: string,
) {
  response.setHeader("WWW-Authenticate", "Bearer");

  return sendApiError(response, 401, { code, message });
}

function isTokenPayload(
  value: unknown,
): value is { sub: string; email: string; role: "user" | "admin" } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    sub?: unknown;
    email?: unknown;
    role?: unknown;
  };

  return (
    typeof candidate.sub === "string" &&
    candidate.sub.length > 0 &&
    typeof candidate.email === "string" &&
    candidate.email.length > 0 &&
    (candidate.role === "user" || candidate.role === "admin")
  );
}

/**
 * Verifies Authorization: Bearer <JWT> and stores { userId, email, role }
 * on request context.
 */
export function createVerifyJwtMiddleware(options: VerifyJwtOptions) {
  const { jwtSecret } = options;

  return function verifyJwt(
    request: Request,
    response: Response,
    next: NextFunction,
  ) {
    const authorizationHeader = getHeaderValue(
      request.headers[AUTHORIZATION_HEADER],
    );
    const token = extractBearerToken(authorizationHeader);

    if (token === undefined) {
      return sendUnauthorized(
        response,
        "MISSING_TOKEN",
        "Authentication token is missing",
      );
    }

    try {
      const decoded = jwt.verify(token, jwtSecret);

      if (!isTokenPayload(decoded)) {
        return sendUnauthorized(
          response,
          "INVALID_TOKEN",
          "Authentication token is invalid",
        );
      }

      setAuthenticatedUser({
        userId: decoded.sub,
        email: decoded.email,
        role: decoded.role,
      });

      return next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return sendUnauthorized(
          response,
          "TOKEN_EXPIRED",
          "Authentication token has expired",
        );
      }

      return sendUnauthorized(
        response,
        "INVALID_TOKEN",
        "Authentication token is invalid",
      );
    }
  };
}
