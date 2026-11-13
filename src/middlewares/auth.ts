import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { AppError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";

type AuthTokenPayload = {
  sub: string;
  email: string;
  role: Express.User["role"];
  assignedEventId?: string | null;
  // 發出時的憑證版本；舊版本發出的憑證沒有這個欄位，視為 0
  tv?: number;
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

  let payload: AuthTokenPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
  } catch {
    return next(new AppError(401, "INVALID_TOKEN", "登入狀態已失效"));
  }
  // 未知角色一律拒絕，避免被當成非工作人員而走到主辦路徑
  if (!["OWNER", "ADMIN", "STAFF"].includes(payload.role)) {
    return next(new AppError(401, "INVALID_TOKEN", "登入狀態已失效"));
  }

  // 帳號已刪除、或在這張憑證發出後按過「登出所有裝置」，憑證就不再有效
  prisma.user
    .findUnique({ where: { id: payload.sub }, select: { tokenVersion: true } })
    .then((user) => {
      if (!user || (payload.tv ?? 0) !== user.tokenVersion) {
        return next(new AppError(401, "INVALID_TOKEN", "登入狀態已失效"));
      }
      req.user = {
        id: payload.sub,
        email: payload.email,
        role: payload.role,
        assignedEventId: payload.assignedEventId
      };
      return next();
    })
    .catch(next);
}
