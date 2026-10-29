import { CheckInStatus } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { AppError, ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { requireEventAccess, requireEventOwner } from "../middlewares/event-access.js";
import { attendeeService, PUBLIC_MAX_CAPACITY } from "../services/attendee.service.js";
import { eventService } from "../services/event.service.js";
import { importService } from "../services/import.service.js";
import { emailService } from "../services/email.service.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";

export const attendeeRouter = Router({ mergeParams: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

attendeeRouter.get(
  "/ticket",
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string() }).parse(req.query);
    const attendee = await attendeeService.getByQrToken(req.params.eventId, token);
    return ok(res, attendee);
  })
);

attendeeRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const body = z.object({
      token: z.string().min(1),
      name: z.string().min(1),
      email: z.string().email().optional().or(z.literal("")),
      age: z.coerce.number().int().min(1).max(120).optional(),
      gender: z.enum(["M", "F", "OTHER"]).optional(),
      capacity: z.coerce.number().int().min(1).max(PUBLIC_MAX_CAPACITY).optional(),
      customFields: z.record(z.string(), z.union([z.string(), z.number()])).optional()
    }).parse(req.body);
    const attendee = await attendeeService.completeRegistration(req.params.eventId, body.token, body);
    return ok(res, attendee);
  })
);

attendeeRouter.use(requireAuth);

attendeeRouter.get(
  "/",
  requireEventAccess,
  asyncHandler(async (req, res) => {
    const { search, status } = z.object({
      search: z.string().optional(),
      status: z.nativeEnum(CheckInStatus).optional()
    }).parse(req.query);
    const attendees = await attendeeService.list(req.params.eventId, search, status);
    return ok(res, attendees);
  })
);

attendeeRouter.post(
  "/",
  requireEventOwner,
  asyncHandler(async (req, res) => {
    const body = z.object({
      name: z.string().min(1, "姓名不能為空"),
      phone: z.string().min(1, "電話不能為空"),
      email: z.string().email("Email 格式不正確").optional().or(z.literal("")),
      capacity: z.coerce.number().int().min(1).max(20).optional()
    }).parse(req.body);
    const attendee = await attendeeService.createSingle(req.params.eventId, req.user!.id, body);
    return ok(res, attendee, 201);
  })
);

const decisionSchema = z.object({
  action: z.enum(["UPDATE", "NEW", "SKIP"]),
  targetId: z.string().optional()
});

// 匯入分三步：上傳預覽（不寫入）→ 逐筆處理疑似重複 → 確認後才新增、更新與扣點
attendeeRouter.post(
  "/import/preview",
  requireEventOwner,
  upload.single("file") as never,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, "FILE_REQUIRED", "請上傳檔案");
    // multer 以 latin1 解讀檔名，轉回 UTF-8 才不會讓中文檔名變亂碼
    const fileName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const preview = await importService.createPreview(req.params.eventId, req.user!.id, fileName, req.file.buffer);
    return ok(res, preview, 201);
  })
);

attendeeRouter.get(
  "/imports",
  requireEventOwner,
  asyncHandler(async (req, res) => {
    return ok(res, await importService.listHistory(req.params.eventId, req.user!.id));
  })
);

attendeeRouter.get(
  "/import/:sessionId",
  requireEventOwner,
  asyncHandler(async (req, res) => {
    return ok(res, await importService.getPreview(req.params.eventId, req.user!.id, req.params.sessionId));
  })
);

attendeeRouter.put(
  "/import/:sessionId/decisions",
  requireEventOwner,
  asyncHandler(async (req, res) => {
    const body = z.object({
      decisions: z.record(z.string(), decisionSchema).optional(),
      bulk: z.enum(["ALL_NEW", "ALL_SKIP"]).optional()
    }).parse(req.body);
    return ok(res, await importService.setDecisions(req.params.eventId, req.user!.id, req.params.sessionId, body));
  })
);

attendeeRouter.post(
  "/import/:sessionId/confirm",
  requireEventOwner,
  asyncHandler(async (req, res) => {
    const body = z.object({
      expectedCost: z.number().int().min(0),
      decisions: z.record(z.string(), decisionSchema).optional()
    }).parse(req.body);
    return ok(res, await importService.confirm(req.params.eventId, req.user!.id, req.params.sessionId, body));
  })
);

attendeeRouter.get(
  "/export",
  requireEventOwner,
  asyncHandler(async (req, res) => {
    const { format } = z.object({
      format: z.enum(["csv", "xlsx"]).default("csv")
    }).parse(req.query);

    if (format === "xlsx") {
      const buf = await attendeeService.exportXlsx(req.params.eventId);
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="monmate-attendees-${req.params.eventId}.xlsx"`);
      return res.send(buf);
    }

    const csv = await attendeeService.exportCsv(req.params.eventId);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="monmate-attendees-${req.params.eventId}.csv"`);
    return res.send(csv);
  })
);

attendeeRouter.patch(
  "/:attendeeId",
  requireEventAccess,
  asyncHandler(async (req, res) => {
    const body = z.object({
      name: z.string().min(1).optional(),
      phone: z.string().min(1).optional(),
      email: z.string().email().nullable().optional().or(z.literal("").transform(() => null)),
      age: z.coerce.number().int().min(1).max(120).nullable().optional(),
      gender: z.enum(["M", "F", "OTHER"]).nullable().optional(),
      checkInStatus: z.nativeEnum(CheckInStatus).optional(),
      checkedInAt: z.string().nullable().optional(),
      checkInCapacity: z.coerce.number().int().min(1).max(999).optional(),
      checkInCount: z.coerce.number().int().min(0).max(999).optional(),
      customFields: z.record(z.string(), z.union([z.string(), z.number()])).nullable().optional(),
      note: z.string().nullable().optional()
    }).parse(req.body);
    // 工作人員只能編輯備註；其餘欄位（含人數、報到狀態）僅限主辦
    if (req.user!.role === "STAFF") {
      const forbidden = Object.keys(body).filter((k) => k !== "note");
      if (forbidden.length > 0) throw new AppError(403, "FORBIDDEN", "工作人員僅能編輯備註");
    }
    const attendee = await attendeeService.update(req.params.eventId, req.params.attendeeId, body);
    return ok(res, attendee);
  })
);

attendeeRouter.post(
  "/:attendeeId/invite",
  requireEventOwner,
  asyncHandler(async (req, res) => {
    const { template } = z.object({
      template: z.enum(["with-registration", "without-registration"]).default("without-registration")
    }).parse(req.body);

    const event = await eventService.get(req.params.eventId);
    const attendee = await prisma.attendee.findUnique({
      where: { id: req.params.attendeeId },
      select: { name: true, email: true, qrToken: true }
    });
    if (!attendee) throw new AppError(404, "ATTENDEE_NOT_FOUND", "找不到報名資料");
    if (!attendee.email) return ok(res, { success: false, message: "此學員無 Email，無法寄送" });

    const webUrl = env.WEB_APP_URL.replace(/\/$/, "");
    const ticketUrl = template === "with-registration"
      ? `${webUrl}/event/${event.slug}/register?token=${attendee.qrToken}`
      : `${webUrl}/event/${event.slug}/ticket?token=${attendee.qrToken}`;
    const result = await emailService.send({
      to: attendee.email,
      attendeeName: attendee.name,
      eventName: event.name,
      eventDate: new Date(event.startAt).toLocaleDateString("zh-TW"),
      eventPageUrl: `${webUrl}/event/${event.slug}`,
      ticketUrl,
      template
    });

    return ok(res, result);
  })
);
