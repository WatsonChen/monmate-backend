import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env";
import { AppError } from "../lib/http";

type AuthTokenPayload = {
  sub: string;
  email: string;
  role: Express.User["role"];
};

export function requireRole(...roles: Express.User["role"][]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new AppError(401, "UNAUTHORIZED", "請先登入"));
    if (!roles.includes(req.user.role)) {
      return next(new AppError(403, "FORBIDDEN", "權限不足"));
    }
    return next();
  };
}

export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    return next(new AppError(401, "UNAUTHORIZED", "請先登入"));
  }

  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role
    };
    return next();
  } catch {
    return next(new AppError(401, "INVALID_TOKEN", "登入狀態已失效"));
  }
}
