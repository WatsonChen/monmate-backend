import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { checkInService } from "../services/check-in.service.js";

export const checkInRouter = Router({ mergeParams: true });

const qrSchema = z.object({
  qrToken: z.string().min(1)
});

const manualSchema = z.object({
  checkInCode: z.string().min(1)
});

const selfCheckInSchema = z.object({
  checkInCode: z.string().min(1),
  venueCode: z.string().min(1)
});

// 工作人員後台用：掃描受邀者 QR code
checkInRouter.post(
  "/qr",
  requireAuth,
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
  asyncHandler(async (req, res) => {
    const body = manualSchema.parse(req.body);
    const result = await checkInService.byManualCode(
      req.params.eventId,
      body.checkInCode
    );
    return ok(res, result);
  })
);

// 受邀者自助報到：需帶現場 venueCode 驗證
checkInRouter.post(
  "/self",
  asyncHandler(async (req, res) => {
    const body = selfCheckInSchema.parse(req.body);
    const result = await checkInService.bySelfCheckIn(
      req.params.eventId,
      body.checkInCode,
      body.venueCode
    );
    return ok(res, result);
  })
);

checkInRouter.get(
  "/logs",
  requireAuth,
  asyncHandler(async (req, res) => {
    const logs = await checkInService.listLogs(req.params.eventId);
    return ok(res, logs);
  })
);
