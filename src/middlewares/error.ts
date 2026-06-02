import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError, fail } from "../lib/http";

export function notFound(req: Request, res: Response) {
  return fail(res, 404, "NOT_FOUND", `找不到路由 ${req.method} ${req.path}`);
}

export function errorHandler(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (error instanceof AppError) {
    return fail(res, error.statusCode, error.code, error.message);
  }

  if (error instanceof ZodError) {
    return fail(res, 400, "VALIDATION_ERROR", error.issues[0]?.message ?? "資料格式錯誤");
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return fail(res, 409, "DUPLICATE_RECORD", "資料已存在，請改用其他名稱或代碼");
    }

    if (error.code === "P2025") {
      return fail(res, 404, "RECORD_NOT_FOUND", "找不到資料");
    }
  }

  console.error(error);
  return fail(res, 500, "INTERNAL_SERVER_ERROR", "伺服器發生錯誤");
}
