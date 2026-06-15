import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok, AppError } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { checkInService } from "../services/check-in.service.js";
import { prisma } from "../lib/prisma.js";
import { CheckInMethod } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";

// JWT 裡的 assignedEventId 可能是舊 token 導致為 null，
// 此時從 DB 取最新值，避免要求使用者重新登入。
function requireStaffOrAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new AppError(401, "UNAUTHORIZED", "請先登入"));
  if (req.user.role !== "STAFF") return next();

  // STAFF: 從 JWT 取 assignedEventId，若 JWT 是舊格式（null）再查 DB
  const fromJwt = req.user.assignedEventId ?? null;
  if (fromJwt !== null) {
    if (fromJwt !== req.params.eventId) return next(new AppError(403, "FORBIDDEN", "無法操作非指派活動"));
    return next();
  }

  // JWT 無值 → 查 DB（兼容舊 token）
  prisma.user.findUnique({ where: { id: req.user.id }, select: { assignedEventId: true } })
    .then((u) => {
      if ((u?.assignedEventId ?? null) !== req.params.eventId) {
        return next(new AppError(403, "FORBIDDEN", "無法操作非指派活動"));
      }
      return next();
    })
    .catch(next);
}

export const checkInRouter = Router({ mergeParams: true });

const countField = z.coerce.number().int().min(1).max(20).default(1);

const qrSchema    = z.object({ qrToken: z.string().min(1), count: countField });
const manualSchema = z.object({ checkInCode: z.string().min(1), count: countField });
const phoneSchema  = z.object({ phone: z.string().min(1), count: countField });

const lookupSchema = z.union([
  z.object({ qrToken:     z.string().min(1) }),
  z.object({ checkInCode: z.string().min(1) }),
  z.object({ phone:       z.string().min(1) })
]);

const selfCheckInSchema = z.object({
  venueCode: z.string().min(1)
}).and(
  z.union([
    z.object({ phone: z.string().min(1) }),
    z.object({ checkInCode: z.string().min(1) })
  ])
);

// 查詢（不報到）——前台掃描後先預覽，選人數後再送確認
checkInRouter.post(
  "/lookup",
  requireAuth,
  requireStaffOrAdmin,
  asyncHandler(async (req, res) => {
    const body = lookupSchema.parse(req.body);
    const [method, credential] =
      "qrToken"     in body ? [CheckInMethod.QR_CODE,     body.qrToken] :
      "phone"        in body ? [CheckInMethod.PHONE,        body.phone] :
                               [CheckInMethod.MANUAL_CODE, body.checkInCode];
    const result = await checkInService.lookup(req.params.eventId, method, credential);
    return ok(res, result);
  })
);

// 工作人員後台用：掃描受邀者 QR code
checkInRouter.post(
  "/qr",
  requireAuth,
  requireStaffOrAdmin,
  asyncHandler(async (req, res) => {
    const body = qrSchema.parse(req.body);
    const result = await checkInService.byQrToken(req.params.eventId, body.qrToken, body.count);
    return ok(res, result);
  })
);

// 工作人員後台用：手動輸入代碼
checkInRouter.post(
  "/manual",
  requireAuth,
  requireStaffOrAdmin,
  asyncHandler(async (req, res) => {
    const body = manualSchema.parse(req.body);
    const result = await checkInService.byManualCode(req.params.eventId, body.checkInCode, body.count);
    return ok(res, result);
  })
);

// 工作人員後台用：電話號碼查詢
checkInRouter.post(
  "/phone",
  requireAuth,
  requireStaffOrAdmin,
  asyncHandler(async (req, res) => {
    const body = phoneSchema.parse(req.body);
    const result = await checkInService.byPhone(req.params.eventId, body.phone, body.count);
    return ok(res, result);
  })
);

// 受邀者自助報到：需帶現場 venueCode 驗證
checkInRouter.post(
  "/self",
  asyncHandler(async (req, res) => {
    const body = selfCheckInSchema.parse(req.body);
    const credential = "phone" in body ? { phone: body.phone } : { checkInCode: body.checkInCode };
    const result = await checkInService.bySelfCheckIn(req.params.eventId, body.venueCode, credential);
    return ok(res, result);
  })
);

checkInRouter.get(
  "/logs",
  requireAuth,
  requireStaffOrAdmin,
  asyncHandler(async (req, res) => {
    const logs = await checkInService.listLogs(req.params.eventId);
    return ok(res, logs);
  })
);
