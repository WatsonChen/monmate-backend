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
    const result = await notificationService.sendPreEvent(req.params.eventId);
    return ok(res, result, 202);
  })
);

notificationRouter.post(
  "/invite-email",
  asyncHandler(async (req, res) => {
    const body = z.object({
      attendeeIds: z.array(z.string()).min(1),
      registrationRequired: z.boolean().default(false)
    }).parse(req.body);

    const result = await notificationService.sendInviteEmails(
      req.params.eventId,
      body.attendeeIds,
      body.registrationRequired
    );
    return ok(res, result, 202);
  })
);
