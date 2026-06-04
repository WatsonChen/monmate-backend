import { CheckInStatus } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { AppError, ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { attendeeService } from "../services/attendee.service.js";

export const attendeeRouter = Router({ mergeParams: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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
      gender: z.enum(["M", "F", "OTHER"]).optional()
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
  "/import",
  upload.single("file") as never,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, "FILE_REQUIRED", "請上傳 Excel 檔案");
    const result = await attendeeService.importFromExcel(req.params.eventId, req.file.buffer, req.user!.id);
    return ok(res, result, 201);
  })
);

attendeeRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
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
      checkedInAt: z.string().nullable().optional()
    }).parse(req.body);
    const attendee = await attendeeService.update(req.params.eventId, req.params.attendeeId, body);
    return ok(res, attendee);
  })
);
