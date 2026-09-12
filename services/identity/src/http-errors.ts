import type { Response } from "express";

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export function sendApiError(
  response: Response,
  status: number,
  descriptor: {
    code: string;
    message: string;
    details?: unknown;
  },
): Response {
  const body: ApiErrorBody = {
    error: {
      code: descriptor.code,
      message: descriptor.message,
      ...(descriptor.details === undefined
        ? {}
        : { details: descriptor.details }),
    },
  };

  return response.status(status).json(body);
}
