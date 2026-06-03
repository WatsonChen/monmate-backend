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

checkInRouter.post(
  "/qr",
  asyncHandler(async (req, res) => {
    const body = qrSchema.parse(req.body);
    const result = await checkInService.byQrToken(
      req.params.eventId,
      body.qrToken
    );
    return ok(res, result);
  })
);

checkInRouter.post(
  "/manual",
  asyncHandler(async (req, res) => {
    const body = manualSchema.parse(req.body);
    const result = await checkInService.byManualCode(
      req.params.eventId,
      body.checkInCode
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
