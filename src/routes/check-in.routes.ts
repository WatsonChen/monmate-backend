import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok, AppError } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { checkInService } from "../services/check-in.service.js";
import type { NextFunction, Request, Response } from "express";

function requireStaffOrAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new AppError(401, "UNAUTHORIZED", "請先登入"));
  if (req.user.role === "STAFF" && req.user.assignedEventId !== req.params.eventId) {
    return next(new AppError(403, "FORBIDDEN", "無法操作非指派活動"));
  }
  return next();
}

export const checkInRouter = Router({ mergeParams: true });

const qrSchema = z.object({
  qrToken: z.string().min(1)
});

const manualSchema = z.object({
  checkInCode: z.string().min(1)
});

const phoneSchema = z.object({
  phone: z.string().min(1)
});

const selfCheckInSchema = z.object({
  venueCode: z.string().min(1)
}).and(
  z.union([
    z.object({ phone: z.string().min(1) }),
    z.object({ checkInCode: z.string().min(1) })
  ])
);

// 工作人員後台用：掃描受邀者 QR code
checkInRouter.post(
  "/qr",
  requireAuth,
  requireStaffOrAdmin,
  asyncHandler(async (req, res) => {
    const body = qrSchema.parse(req.body);
    const result = await checkInService.byQrToken(
      req.params.eventId,
      body.qrToken
    );
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
    const result = await checkInService.byManualCode(
      req.params.eventId,
      body.checkInCode
    );
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
    const result = await checkInService.byPhone(
      req.params.eventId,
      body.phone
    );
    return ok(res, result);
  })
);

// 受邀者自助報到：需帶現場 venueCode 驗證
checkInRouter.post(
  "/self",
  asyncHandler(async (req, res) => {
    const body = selfCheckInSchema.parse(req.body);
    const credential = "phone" in body
      ? { phone: body.phone }
      : { checkInCode: body.checkInCode };
    const result = await checkInService.bySelfCheckIn(
      req.params.eventId,
      body.venueCode,
      credential
    );
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
