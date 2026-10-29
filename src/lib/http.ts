import type { ApiResponse } from "@monmate/types";
import type { Response } from "express";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function ok<T>(res: Response, data: T, statusCode = 200): Response {
  const body: ApiResponse<T> = { success: true, data };
  return res.status(statusCode).json(body);
}

export function fail(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: unknown
): Response {
  const body: ApiResponse<never> = {
    success: false,
    error: details === undefined ? { code, message } : { code, message, details }
  };
  return res.status(statusCode).json(body);
}
