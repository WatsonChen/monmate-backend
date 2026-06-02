import type { ApiResponse } from "@monmate/types";
import type { Response } from "express";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string
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
  message: string
): Response {
  const body: ApiResponse<never> = {
    success: false,
    error: { code, message }
  };
  return res.status(statusCode).json(body);
}
