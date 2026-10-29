import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { requireEventAccess } from "../middlewares/event-access.js";
import { checkInService } from "../services/check-in.service.js";
import { CheckInMethod } from "@prisma/client";

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
  requireEventAccess,
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
  requireEventAccess,
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
  requireEventAccess,
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
  requireEventAccess,
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
  requireEventAccess,
  asyncHandler(async (req, res) => {
    const logs = await checkInService.listLogs(req.params.eventId);
    return ok(res, logs);
  })
);
