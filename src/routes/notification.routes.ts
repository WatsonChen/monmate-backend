import { Router } from "express";
import { asyncHandler } from "../lib/async-handler";
import { ok } from "../lib/http";
import { requireAuth } from "../middlewares/auth";
import { notificationService } from "../services/notification.service";

export const notificationRouter = Router({ mergeParams: true });

notificationRouter.use(requireAuth);

notificationRouter.post(
  "/pre-event",
  asyncHandler(async (req, res) => {
    const result = await notificationService.sendPreEvent(req.params.eventId);
    return ok(res, result, 202);
  })
);
