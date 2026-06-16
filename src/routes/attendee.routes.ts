import { CheckInStatus } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { AppError, ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { attendeeService } from "../services/attendee.service.js";
import { eventService } from "../services/event.service.js";
import { smsService } from "../services/sms.service.js";
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
      customFields: z.record(z.string(), z.union([z.string(), z.number()])).optional()
    }).parse(req.body);
    const attendee = await attendeeService.completeRegistration(req.params.eventId, body.token, body);
    return ok(res, attendee);
  })
);

attendeeRouter.use(requireAuth);

attendeeRouter.get(
  "/",
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
  asyncHandler(async (req, res) => {
    const body = z.object({
      name: z.string().min(1, "姓名不能為空"),
      phone: z.string().min(1, "電話不能為空"),
      capacity: z.coerce.number().int().min(1).max(20).optional()
    }).parse(req.body);
    const attendee = await attendeeService.createSingle(req.params.eventId, req.user!.id, body);
    return ok(res, attendee, 201);
  })
);

attendeeRouter.post(
  "/import",
  upload.single("file") as never,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, "FILE_REQUIRED", "請上傳檔案");
    const result = await attendeeService.importFromFile(req.params.eventId, req.file.buffer, req.user!.id);
    return ok(res, result, 201);
  })
);

attendeeRouter.get(
  "/export",
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
  asyncHandler(async (req, res) => {
    const body = z.object({
      name: z.string().min(1).optional(),
      phone: z.string().min(1).optional(),
      checkInStatus: z.nativeEnum(CheckInStatus).optional(),
      checkedInAt: z.string().nullable().optional(),
      checkInCapacity: z.coerce.number().int().min(1).max(999).optional(),
      checkInCount: z.coerce.number().int().min(0).max(999).optional(),
      note: z.string().nullable().optional()
    }).parse(req.body);
    const attendee = await attendeeService.update(req.params.eventId, req.params.attendeeId, body);
    return ok(res, attendee);
  })
);

attendeeRouter.post(
  "/:attendeeId/invite",
  asyncHandler(async (req, res) => {
    const { template, senderName } = z.object({
      template: z.enum(["with-registration", "without-registration"]),
      senderName: z.string().max(20).optional()
    }).parse(req.body);

    const event = await eventService.get(req.params.eventId);
    const attendee = await prisma.attendee.findUnique({
      where: { id: req.params.attendeeId },
      select: { name: true, phone: true, qrToken: true }
    });
    if (!attendee) throw new AppError(404, "ATTENDEE_NOT_FOUND", "找不到報名資料");

    const webUrl = env.WEB_APP_URL.replace(/\/$/, "");
    const result = await smsService.send({
      phone: attendee.phone,
      attendeeName: attendee.name,
      eventName: event.name,
      eventDate: new Date(event.startAt).toLocaleDateString("zh-TW"),
      ticketUrl: `${webUrl}/event/${event.slug}?token=${attendee.qrToken}`,
      template,
      senderName
    });

    return ok(res, result);
  })
);
