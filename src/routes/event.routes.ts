import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { asyncHandler } from "../lib/async-handler.js";
import { ok, AppError } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { requireEventAccess, requireEventOwner } from "../middlewares/event-access.js";
import { eventService, FEATURE_UNLOCK_COSTS, type FeatureUnlockKey } from "../services/event.service.js";
import { emailService } from "../services/email.service.js";
import { normalizeName, normalizePhone } from "../lib/identity.js";
import { chargeWallet } from "../services/credit-wallet.service.js";
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
  logoUrl: z.string().url().optional(),
  coverImageUrl: z.string().url().optional(),
  attendeeLimit: z.number().int().positive().optional(),
  allowOverCapacity: z.boolean().optional(),
  registrationRequired: z.boolean().optional(),
  openRegistration: z.boolean().optional(),
  selfCheckInBufferMinutes: z.number().int().min(0).nullable().optional(),
  registrationFields: registrationFieldSchema.optional()
});

const updateEventSchema = createEventSchema.partial().extend({
  description: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  endAt: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  logoUrl: z.string().url().nullable().optional(),
  coverImageUrl: z.string().url().nullable().optional()
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
  name: z.string().min(1, "請填寫姓名").max(100),
  phone: z.string().min(6, "請填寫電話").max(30),
  // 瀏覽器產生的隨機請求識別碼，僅用於「同一次送出」的重試防重
  requestId: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional()
});

eventRouter.post(
  "/public/:slug/register",
  asyncHandler(async (req, res) => {
    const { name, phone, requestId } = publicRegisterSchema.parse(req.body);
    const event = await eventService.getPublicBySlug(req.params.slug);

    if (!event.openRegistration) {
      throw new AppError(403, "REGISTRATION_CLOSED", "此活動未開放公開報名");
    }

    const owner = await prisma.event.findUnique({
      where: { id: event.id },
      select: { createdById: true }
    });
    if (!owner) throw new AppError(404, "EVENT_NOT_FOUND", "找不到活動");

    const cleanName = name.trim();
    const cleanPhone = phone.trim();
    const sameIdentity = (a: { name: string; phone: string }) =>
      normalizeName(a.name) === normalizeName(cleanName) && normalizePhone(a.phone) === normalizePhone(cleanPhone);

    const { randomBytes } = await import("node:crypto");
    const qrToken = randomBytes(18).toString("base64url");

    // 身份辨識與重試防重分開：
    // - 重試防重：只認「同一個請求識別碼」，且姓名與電話都要一致，才回傳先前的憑證
    // - 身份：同電話不代表同一人；只有「姓名與電話都相同」才視為已報名，且不回傳任何憑證
    // 公開報名依人頭扣 1 點（無攜伴），由主辦錢包支付，受 -3 點下限約束。
    let outcome: { qrToken: string; replay: boolean };
    try {
      outcome = await createAttendeeWithUniqueCode((checkInCode) =>
        prisma.$transaction(async (tx) => {
          // 同活動同電話的請求序列化，避免並行時重複新增
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${event.id + ":" + normalizePhone(cleanPhone)}))`;

          let keyToStore: string | undefined = requestId;
          if (requestId) {
            const byKey = await tx.attendee.findUnique({
              where: { eventId_registrationKey: { eventId: event.id, registrationKey: requestId } },
              select: { name: true, phone: true, qrToken: true }
            });
            if (byKey) {
              if (sameIdentity(byKey)) return { qrToken: byKey.qrToken, replay: true };
              keyToStore = undefined; // 識別碼已被別筆使用，這筆不綁定
            }
          }

          // 電話以去除空白、連字號、括號後的格式比對（資料庫存的是原始輸入）
          const samePhone = await tx.$queryRaw<{ name: string; phone: string }[]>`
            SELECT "name", "phone" FROM "Attendee"
            WHERE "eventId" = ${event.id}
              AND regexp_replace("phone", '[[:space:]()（）-]', '', 'g') = ${normalizePhone(cleanPhone)}`;
          if (samePhone.some(sameIdentity)) {
            throw new AppError(409, "ALREADY_REGISTERED", "此姓名與電話已報名。請使用先前取得的報到連結，或聯絡主辦單位。");
          }

          // 未開放超額時，用人頭（checkInCapacity 加總）判斷是否已滿；公開報名每筆固定 1 人
          if (!event.allowOverCapacity && event.attendeeLimit) {
            const agg = await tx.attendee.aggregate({ where: { eventId: event.id }, _sum: { checkInCapacity: true } });
            if ((agg._sum.checkInCapacity ?? 0) + 1 > event.attendeeLimit) {
              throw new AppError(409, "CAPACITY_FULL", "此活動報名名額已滿");
            }
          }

          const created = await tx.attendee.create({
            data: {
              eventId: event.id,
              name: cleanName,
              phone: cleanPhone,
              checkInCode,
              qrToken,
              registrationKey: keyToStore
            },
            select: { id: true, qrToken: true }
          });
          await chargeWallet(tx, {
            userId: owner.createdById,
            amount: 1,
            reason: "ATTENDEE_CREATE",
            eventId: event.id,
            attendeeId: created.id,
            note: "公開報名"
          });
          return { qrToken: created.qrToken, replay: false };
        })
      );
    } catch (err) {
      // 點數不足時只告訴來賓「目前無法報名」，不暴露主辦的餘額或帳務資訊
      if (err instanceof AppError && err.code === "INSUFFICIENT_ATTENDEE_CREDITS") {
        throw new AppError(409, "REGISTRATION_UNAVAILABLE", "目前無法完成報名，請聯絡主辦單位");
      }
      throw err;
    }

    return ok(res, { qrToken: outcome.qrToken }, outcome.replay ? 200 : 201);
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
  requireEventAccess,
  asyncHandler(async (req, res) => {
    const event = await eventService.get(req.params.eventId);
    return ok(res, event);
  })
);

eventRouter.patch(
  "/:eventId",
  requireEventOwner,
  asyncHandler(async (req, res) => {
    const body = updateEventSchema.parse(req.body);
    const event = await eventService.update(req.params.eventId, body);
    return ok(res, event);
  })
);

eventRouter.delete(
  "/:eventId",
  requireEventOwner,
  asyncHandler(async (req, res) => {
    const result = await eventService.delete(req.params.eventId);
    return ok(res, result);
  })
);

const unlockFeatureSchema = z.object({
  feature: z.enum(Object.keys(FEATURE_UNLOCK_COSTS) as [FeatureUnlockKey, ...FeatureUnlockKey[]])
});

eventRouter.post(
  "/:eventId/unlock-feature",
  requireEventOwner,
  asyncHandler(async (req, res) => {
    const { feature } = unlockFeatureSchema.parse(req.body);
    const event = await eventService.unlockFeature(req.params.eventId, req.user!.id, feature);
    return ok(res, event);
  })
);

eventRouter.get(
  "/:eventId/analytics",
  requireEventOwner,
  asyncHandler(async (req, res) => {
    const analytics = await eventService.getAnalytics(req.params.eventId);
    return ok(res, analytics);
  })
);

eventRouter.get(
  "/:eventId/venue-qr",
  requireEventAccess,
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
  requireEventOwner,
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
  requireEventOwner,
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
  requireEventOwner,
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
  requireEventOwner,
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
