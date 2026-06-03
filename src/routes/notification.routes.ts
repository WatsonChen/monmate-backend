import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { notificationService } from "../services/notification.service.js";

export const notificationRouter = Router({ mergeParams: true });

notificationRouter.use(requireAuth);

notificationRouter.post(
  "/pre-event",
  asyncHandler(async (req, res) => {
    const result = await notificationService.sendPreEvent(req.params.eventId);
    return ok(res, result, 202);
  })
);
