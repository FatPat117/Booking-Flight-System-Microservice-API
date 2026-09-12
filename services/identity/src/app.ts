import express from "express";

import { sendApiError } from "./http-errors.js";
import type { LoginUser } from "./login/login.js";
import type { RegisterUser } from "./register/register.js";

export type IdentityAppDependencies = {
  registerUser: RegisterUser;
  loginUser: LoginUser;
};

export function createIdentityApp(dependencies: IdentityAppDependencies) {
  const { registerUser, loginUser } = dependencies;
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

  app.post("/api/identity/login", async (request, response) => {
    const result = await loginUser(request.body);

    if (result.outcome === "validation_failed") {
      return sendApiError(response, 422, {
        code: "VALIDATION_FAILED",
        message: "Request contains invalid login data",
        details: result.issues,
      });
    }

    if (result.outcome === "invalid_credentials") {
      return sendApiError(response, 401, {
        code: "INVALID_CREDENTIALS",
        message: "Email or password is incorrect",
      });
    }

    return response.status(200).json(result.token);
  });

  app.use((_request, response) => {
    return sendApiError(response, 404, {
      code: "NOT_FOUND",
      message: "Route was not found",
    });
  });

  return app;
}
