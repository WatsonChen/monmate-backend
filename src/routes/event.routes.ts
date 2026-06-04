import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { eventService } from "../services/event.service.js";
import { smsService } from "../services/sms.service.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";

export const eventRouter = Router();

const registrationFieldSchema = z.array(z.object({
  key: z.enum(["email", "age", "gender"]),
  required: z.boolean()
}));

const createEventSchema = z.object({
  name: z.string().min(1),
  slug: z.string().optional(),
  description: z.string().optional(),
  content: z.string().optional(),
  startAt: z.string().min(1),
  endAt: z.string().optional(),
  location: z.string().optional(),
  registrationRequired: z.boolean().optional(),
  registrationFields: registrationFieldSchema.optional()
});

const updateEventSchema = createEventSchema.partial().extend({
  description: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  endAt: z.string().nullable().optional(),
  location: z.string().nullable().optional()
});

eventRouter.get(
  "/public/:slug",
  asyncHandler(async (req, res) => {
    const event = await eventService.getPublicBySlug(req.params.slug);
    return ok(res, event);
  })
);

eventRouter.get(
  "/ticket/:slug",
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string() }).parse(req.query);
    const event = await eventService.getPublicBySlug(req.params.slug);
    const attendee = await prisma.attendee.findFirst({
      where: { eventId: event.id, qrToken: token },
      select: { id: true, name: true, phone: true, checkInCode: true, qrToken: true, checkInStatus: true }
    });
    return ok(res, { event, attendee });
  })
);

eventRouter.use(requireAuth);

eventRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const events = await eventService.list(req.user!.id);
    return ok(res, events);
  })
);

eventRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = createEventSchema.parse(req.body);
    const event = await eventService.create({ ...body, createdById: req.user!.id });
    return ok(res, event, 201);
  })
);

eventRouter.get(
  "/:eventId",
  asyncHandler(async (req, res) => {
    const event = await eventService.get(req.params.eventId);
    return ok(res, event);
  })
);

eventRouter.patch(
  "/:eventId",
  asyncHandler(async (req, res) => {
    const body = updateEventSchema.parse(req.body);
    const event = await eventService.update(req.params.eventId, body);
    return ok(res, event);
  })
);

eventRouter.delete(
  "/:eventId",
  asyncHandler(async (req, res) => {
    const result = await eventService.delete(req.params.eventId);
    return ok(res, result);
  })
);

eventRouter.get(
  "/:eventId/analytics",
  asyncHandler(async (req, res) => {
    const analytics = await eventService.getAnalytics(req.params.eventId);
    return ok(res, analytics);
  })
);

eventRouter.get(
  "/:eventId/venue-qr",
  asyncHandler(async (req, res) => {
    const event = await prisma.event.findUnique({
      where: { id: req.params.eventId },
      select: { slug: true, venueCode: true }
    });
    if (!event) {
      return ok(res, null);
    }
    const webUrl = env.WEB_APP_URL.replace(/\/$/, "");
    return ok(res, {
      venueCode: event.venueCode,
      venueUrl: `${webUrl}/event/${event.slug}/checkin?v=${event.venueCode}`
    });
  })
);

eventRouter.post(
  "/:eventId/invite",
  asyncHandler(async (req, res) => {
    const { template } = z.object({
      template: z.enum(["with-registration", "without-registration"])
    }).parse(req.body);

    const event = await eventService.get(req.params.eventId);
    const attendees = await prisma.attendee.findMany({
      where: { eventId: req.params.eventId },
      select: { name: true, phone: true, qrToken: true }
    });

    const webUrl = env.WEB_APP_URL.replace(/\/$/, "");
    const results = await smsService.sendBulk(
      attendees.map((a) => ({
        phone: a.phone,
        attendeeName: a.name,
        eventName: event.name,
        eventDate: new Date(event.startAt).toLocaleDateString("zh-TW"),
        ticketUrl: template === "with-registration"
          ? `${webUrl}/event/${event.slug}/register?token=${a.qrToken}`
          : `${webUrl}/event/${event.slug}/ticket?token=${a.qrToken}`,
        template
      }))
    );

    return ok(res, results);
  })
);
