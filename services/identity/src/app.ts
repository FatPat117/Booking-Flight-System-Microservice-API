import express from "express";

import { sendApiError } from "./http-errors.js";
import type { RegisterUser } from "./register/register.js";

export type IdentityAppDependencies = {
  registerUser: RegisterUser;
};

export function createIdentityApp(dependencies: IdentityAppDependencies) {
  const { registerUser } = dependencies;
  const app = express();

  app.use(express.json({ strict: false }));

  app.get("/live", (_request, response) => {
    return response.status(200).json({ status: "ok" });
  });

  app.post("/api/identity/register", async (request, response) => {
    const result = await registerUser(request.body);

    if (result.outcome === "validation_failed") {
      return sendApiError(response, 422, {
        code: "VALIDATION_FAILED",
        message: "Request contains invalid registration data",
        details: result.issues,
      });
    }

    if (result.outcome === "duplicate_email") {
      return sendApiError(response, 409, {
        code: "EMAIL_ALREADY_REGISTERED",
        message: "An account with this email already exists",
      });
    }

    return response.status(201).json(result.user);
  });

  app.use((_request, response) => {
    return sendApiError(response, 404, {
      code: "NOT_FOUND",
      message: "Route was not found",
    });
  });

  return app;
}
