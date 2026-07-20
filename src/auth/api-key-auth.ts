import type { NextFunction, Request, Response } from "express";

import { sendApiError } from "../http-errors.js";

export type ApiKeyAuthOptions = {
  adminApiKey: string;
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

function sendUnauthenticated(response: Response) {
  response.setHeader("WWW-Authenticate", "Bearer");

  return sendApiError(response, 401, {
    code: "UNAUTHENTICATED",
    message: "Authentication is required",
  });
}

export function createApiKeyAuthMiddleware(options: ApiKeyAuthOptions) {
  const { adminApiKey } = options;

  return function apiKeyAuth(
    request: Request,
    response: Response,
    next: NextFunction,
  ) {
    const authorizationHeader = getHeaderValue(
      request.headers[AUTHORIZATION_HEADER],
    );

    const token = extractBearerToken(authorizationHeader);

    if (!token || token !== adminApiKey) {
      return sendUnauthenticated(response);
    }

    return next();
  };
}
