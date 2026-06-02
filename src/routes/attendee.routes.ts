import { CheckInStatus } from "@prisma/client";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler";
import { AppError, ok } from "../lib/http";
import { requireAuth } from "../middlewares/auth";
import { attendeeService } from "../services/attendee.service";

export const attendeeRouter = Router({ mergeParams: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }
});

const listQuerySchema = z.object({
  search: z.string().optional(),
  status: z.nativeEnum(CheckInStatus).optional()
});

const updateAttendeeSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  checkInStatus: z.nativeEnum(CheckInStatus).optional(),
  checkedInAt: z.string().nullable().optional()
});

attendeeRouter.use(requireAuth);

attendeeRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const query = listQuerySchema.parse(req.query);
    const attendees = await attendeeService.list(
      req.params.eventId,
      query.search,
      query.status
    );
    return ok(res, attendees);
  })
);

attendeeRouter.post(
  "/import",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new AppError(400, "FILE_REQUIRED", "請上傳 Excel 檔案");
    }

    const result = await attendeeService.importFromExcel(
      req.params.eventId,
      req.file.buffer
    );
    return ok(res, result, 201);
  })
);

attendeeRouter.get(
  "/export",
  asyncHandler(async (req, res) => {
    const csv = await attendeeService.exportCsv(req.params.eventId);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="monmate-attendees-${req.params.eventId}.csv"`
    );
    return res.send(csv);
  })
);

attendeeRouter.patch(
  "/:attendeeId",
  asyncHandler(async (req, res) => {
    const body = updateAttendeeSchema.parse(req.body);
    const attendee = await attendeeService.update(
      req.params.eventId,
      req.params.attendeeId,
      body
    );
    return ok(res, attendee);
  })
);
