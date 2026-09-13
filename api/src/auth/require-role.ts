import type { NextFunction, Request, Response } from "express";

import { sendApiError } from "../http-errors.js";
import {
  getAuthenticatedUser,
  type AuthenticatedUser,
} from "../observability/request-context.js";

/**
 * Must run AFTER requireJwt — reads authenticatedUser from request context.
 * If used alone or before verifyJwt, context is empty and this returns 401.
 */
export function requireRole(role: AuthenticatedUser["role"]) {
  return function (_request: Request, response: Response, next: NextFunction) {
    const user = getAuthenticatedUser();

    if (user === undefined) {
      return sendApiError(response, 401, {
        code: "MISSING_TOKEN",
        message: "Authentication required",
      });
    }

    if (user.role !== role) {
      return sendApiError(response, 403, {
        code: "FORBIDDEN",
        message: "Insufficient permissions",
      });
    }

    return next();
  };
}
