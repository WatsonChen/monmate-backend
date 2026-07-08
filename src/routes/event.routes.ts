import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { asyncHandler } from "../lib/async-handler.js";
import { ok, AppError } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { eventService } from "../services/event.service.js";
import { emailService } from "../services/email.service.js";
import { createAttendeeWithUniqueCode } from "../services/attendee.service.js";
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
  openRegistration: z.boolean().optional(),
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

const publicRegisterSchema = z.object({
  name: z.string().min(1, "請填寫姓名"),
  phone: z.string().min(6, "請填寫電話")
});

eventRouter.post(
  "/public/:slug/register",
  asyncHandler(async (req, res) => {
    const { name, phone } = publicRegisterSchema.parse(req.body);
    const event = await eventService.getPublicBySlug(req.params.slug);

    if (!event.openRegistration) {
      throw new AppError(403, "REGISTRATION_CLOSED", "此活動未開放公開報名");
    }

    if (event.attendeeLimit) {
      const count = await prisma.attendee.count({ where: { eventId: event.id } });
      if (count >= event.attendeeLimit) {
        throw new AppError(409, "CAPACITY_FULL", "此活動報名名額已滿");
      }
    }

    // Idempotent: return existing token if same phone already registered
    const existing = await prisma.attendee.findFirst({
      where: { eventId: event.id, phone: phone.trim() },
      select: { qrToken: true }
    });
    if (existing) {
      return ok(res, { qrToken: existing.qrToken });
    }

    const { randomBytes } = await import("node:crypto");
    const qrToken = randomBytes(18).toString("base64url");

    const attendee = await createAttendeeWithUniqueCode((checkInCode) =>
      prisma.attendee.create({
        data: { eventId: event.id, name: name.trim(), phone: phone.trim(), checkInCode, qrToken },
        select: { qrToken: true }
      })
    );

    return ok(res, { qrToken: attendee.qrToken }, 201);
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
      where: { eventId: req.params.eventId, email: { not: null } },
      select: { name: true, email: true, qrToken: true }
    });

    const webUrl = env.WEB_APP_URL.replace(/\/$/, "");
    const results = await emailService.sendBulk(
      attendees
        .filter((a): a is typeof a & { email: string } => !!a.email)
        .map((a) => ({
          to: a.email,
          attendeeName: a.name,
          eventName: event.name,
          eventDate: new Date(event.startAt).toLocaleDateString("zh-TW"),
          ticketUrl: `${webUrl}/event/${event.slug}?token=${a.qrToken}`,
          template
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
    const assignments = await prisma.eventStaffAssignment.findMany({
      where: { eventId: req.params.eventId },
      include: {
        user: { select: { id: true, name: true, email: true } }
      },
      orderBy: { createdAt: "desc" }
    });
    const staff = assignments.map((assignment) => ({
      id: assignment.user.id,
      name: assignment.user.name,
      email: assignment.user.email,
      createdAt: assignment.createdAt
    }));
    return ok(res, staff);
  })
);

eventRouter.post(
  "/:eventId/staff",
  asyncHandler(async (req, res) => {
    const body = createStaffSchema.parse(req.body);
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing && existing.role !== "STAFF") {
      throw new AppError(409, "EMAIL_TAKEN", "此 Email 已是主辦帳號，無法設為工作人員");
    }

    const existingAssignment = existing
      ? await prisma.eventStaffAssignment.findUnique({
          where: { eventId_userId: { eventId: req.params.eventId, userId: existing.id } }
        })
      : null;
    if (existingAssignment) {
      throw new AppError(409, "STAFF_ALREADY_ASSIGNED", "此 Email 已是本活動工作人員");
    }

    const staff = await prisma.$transaction(async (tx) => {
      const user = existing ?? await tx.user.create({
        data: {
          name: body.name,
          email: body.email,
          passwordHash: await bcrypt.hash(body.password, 10),
          role: "STAFF",
          assignedEventId: req.params.eventId
        }
      });

      if (existing && !existing.assignedEventId) {
        await tx.user.update({
          where: { id: existing.id },
          data: { assignedEventId: req.params.eventId }
        });
      }

      const assignment = await tx.eventStaffAssignment.create({
        data: { eventId: req.params.eventId, userId: user.id }
      });

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: assignment.createdAt
      };
    });
    return ok(res, staff, 201);
  })
);

eventRouter.delete(
  "/:eventId/staff/:staffId",
  asyncHandler(async (req, res) => {
    const assignment = await prisma.eventStaffAssignment.findUnique({
      where: { eventId_userId: { eventId: req.params.eventId, userId: req.params.staffId } },
      include: { user: { select: { assignedEventId: true } } }
    });
    if (!assignment) {
      throw new AppError(404, "STAFF_NOT_FOUND", "找不到工作人員");
    }
    await prisma.$transaction(async (tx) => {
      await tx.eventStaffAssignment.delete({
        where: { eventId_userId: { eventId: req.params.eventId, userId: req.params.staffId } }
      });

      if (assignment.user.assignedEventId === req.params.eventId) {
        const nextAssignment = await tx.eventStaffAssignment.findFirst({
          where: { userId: req.params.staffId },
          orderBy: { createdAt: "desc" },
          select: { eventId: true }
        });
        await tx.user.update({
          where: { id: req.params.staffId },
          data: { assignedEventId: nextAssignment?.eventId ?? null }
        });
      }
    });
    return ok(res, { id: req.params.staffId });
  })
);
