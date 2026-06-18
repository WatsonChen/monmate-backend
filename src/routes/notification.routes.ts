import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { notificationService } from "../services/notification.service.js";

export const notificationRouter = Router({ mergeParams: true });

notificationRouter.use(requireAuth);

notificationRouter.post(
  "/pre-event",
  asyncHandler(async (req, res) => {
    const { content = "" } = z.object({ content: z.string().optional() }).parse(req.body);
    const result = await notificationService.sendPreEvent(req.params.eventId, content);
    return ok(res, result, 202);
  })
);
