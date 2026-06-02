import { randomBytes } from "node:crypto";
import { CheckInLogStatus, CheckInStatus } from "@prisma/client";
import { toCsvCell } from "@monmate/utils";
import readXlsxFile from "read-excel-file/node";
import { AppError } from "../lib/http";
import { prisma } from "../lib/prisma";
import { attendeeRepository } from "../repositories/attendee.repository";
import { eventService } from "./event.service";

function createCheckInCode(index: number) {
  return `MM${String(Date.now()).slice(-4)}${String(index + 1).padStart(4, "0")}`;
}

function createQrToken() {
  return randomBytes(18).toString("base64url");
}

export const attendeeService = {
  list(eventId: string, search?: string, status?: CheckInStatus) {
    return attendeeRepository.list(eventId, search, status);
  },

  async importFromExcel(eventId: string, fileBuffer: Buffer) {
    const event = await eventService.get(eventId);

    const rows = await readXlsxFile(fileBuffer);
    if (rows.length < 2) {
      throw new AppError(400, "EMPTY_IMPORT", "匯入檔案沒有工作表");
    }

    const header = rows[0].map((cell) => String(cell ?? "").trim());
    const nameIndex = header.findIndex((cell) =>
      ["name", "姓名"].includes(cell)
    );
    const phoneIndex = header.findIndex((cell) =>
      ["phone", "電話"].includes(cell)
    );

    if (nameIndex < 0 || phoneIndex < 0) {
      throw new AppError(400, "INVALID_COLUMNS", "Excel 需包含姓名與電話欄位");
    }

    const attendees = rows
      .slice(1)
      .map((row, index) => ({
        eventId,
        name: String(row[nameIndex] ?? "").trim(),
        phone: String(row[phoneIndex] ?? "").trim(),
        checkInCode: createCheckInCode(index),
        qrToken: createQrToken()
      }))
      .filter((row) => row.name && row.phone);

    if (attendees.length === 0) {
      throw new AppError(400, "EMPTY_IMPORT", "匯入檔案缺少姓名或電話欄位");
    }

    if (event.attendeeLimit) {
      const existingCount = await prisma.attendee.count({ where: { eventId } });
      if (existingCount + attendees.length > event.attendeeLimit) {
        throw new AppError(
          402,
          "ATTENDEE_LIMIT_EXCEEDED",
          `此活動額度最多支援 ${event.attendeeLimit} 人`
        );
      }
    }

    const result = await attendeeRepository.createMany(attendees);
    return { imported: result.count };
  },

  async exportCsv(eventId: string) {
    const attendees = await attendeeRepository.list(eventId);
    const successLogs = await prisma.checkInLog.findMany({
      where: { eventId, status: CheckInLogStatus.SUCCESS },
      orderBy: { createdAt: "desc" }
    });
    const latestMethodByAttendee = new Map(
      successLogs
        .filter((log) => log.attendeeId)
        .map((log) => [log.attendeeId, log.method])
    );
    const header = ["姓名", "電話", "報到狀態", "報到時間", "報到方式"];
    const rows = attendees.map((attendee) => [
      attendee.name,
      attendee.phone,
      attendee.checkInStatus,
      attendee.checkedInAt?.toISOString() ?? "",
      latestMethodByAttendee.get(attendee.id) ?? ""
    ]);

    return [header, ...rows]
      .map((row) => row.map(toCsvCell).join(","))
      .join("\n");
  },

  async update(
    eventId: string,
    attendeeId: string,
    input: Partial<{
      name: string;
      phone: string;
      checkInStatus: CheckInStatus;
      checkedInAt: string | null;
    }>
  ) {
    const attendee = await attendeeRepository.findById(attendeeId);

    if (!attendee || attendee.eventId !== eventId) {
      throw new AppError(404, "ATTENDEE_NOT_FOUND", "找不到報名資料");
    }

    return attendeeRepository.update(attendeeId, {
      name: input.name,
      phone: input.phone,
      checkInStatus: input.checkInStatus,
      checkedInAt:
        input.checkedInAt === null
          ? null
          : input.checkedInAt
            ? new Date(input.checkedInAt)
            : undefined
    });
  }
};
