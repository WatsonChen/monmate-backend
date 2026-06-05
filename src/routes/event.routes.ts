import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { asyncHandler } from "../lib/async-handler.js";
import { ok, AppError } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { eventService } from "../services/event.service.js";
import { smsService } from "../services/sms.service.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";

export const eventRouter = Router();

const registrationFieldSchema = z.array(z.object({
  key: z.string().min(1),
  label: z.string().optional(),
  type: z.enum(["text", "number", "select"]).optional(),
  options: z.array(z.string()).optional(),
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
  attendeeLimit: z.number().int().positive().optional(),
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
    const { template, senderName } = z.object({
      template: z.enum(["with-registration", "without-registration"]),
      senderName: z.string().max(20).optional()
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
        ticketUrl: `${webUrl}/event/${event.slug}?token=${a.qrToken}`,
        template,
        senderName
      }))
    );

    return ok(res, results);
  })
);

// Staff management

const createStaffSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(6)
});

eventRouter.get(
  "/:eventId/staff",
  asyncHandler(async (req, res) => {
    const staff = await prisma.user.findMany({
      where: { assignedEventId: req.params.eventId, role: "STAFF" },
      select: { id: true, name: true, email: true, createdAt: true }
    });
    return ok(res, staff);
  })
);

eventRouter.post(
  "/:eventId/staff",
  asyncHandler(async (req, res) => {
    const body = createStaffSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw new AppError(409, "EMAIL_TAKEN", "此 Email 已被使用");

    const passwordHash = await bcrypt.hash(body.password, 10);
    const staff = await prisma.user.create({
      data: {
        name: body.name,
        email: body.email,
        passwordHash,
        role: "STAFF",
        assignedEventId: req.params.eventId
      },
      select: { id: true, name: true, email: true, createdAt: true }
    });
    return ok(res, staff, 201);
  })
);

eventRouter.delete(
  "/:eventId/staff/:staffId",
  asyncHandler(async (req, res) => {
    const staff = await prisma.user.findUnique({ where: { id: req.params.staffId } });
    if (!staff || staff.assignedEventId !== req.params.eventId) {
      throw new AppError(404, "STAFF_NOT_FOUND", "找不到工作人員");
    }
    await prisma.user.delete({ where: { id: req.params.staffId } });
    return ok(res, { id: req.params.staffId });
  })
);
