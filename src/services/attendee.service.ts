import { randomBytes } from "node:crypto";
import { CheckInLogStatus, CheckInStatus, Gender } from "@prisma/client";
import { toCsvCell } from "@monmate/utils";
import readXlsxFile from "read-excel-file/node";
import { AppError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { attendeeRepository } from "../repositories/attendee.repository.js";
import { eventService } from "./event.service.js";

function createCheckInCode(index: number) {
  return `MM${String(Date.now()).slice(-4)}${String(index + 1).padStart(4, "0")}`;
}

function createQrToken() {
  return randomBytes(18).toString("base64url");
}

function parseGender(value: string | null | undefined): Gender | undefined {
  const v = String(value ?? "").trim().toUpperCase();
  if (v === "M" || v === "男") return Gender.M;
  if (v === "F" || v === "女") return Gender.F;
  if (v === "OTHER" || v === "其他") return Gender.OTHER;
  return undefined;
}

export const attendeeService = {
  list(eventId: string, search?: string, status?: CheckInStatus) {
    return attendeeRepository.list(eventId, search, status);
  },

  async getByQrToken(eventId: string, qrToken: string) {
    const attendee = await prisma.attendee.findFirst({
      where: { eventId, qrToken },
      select: {
        id: true, name: true, phone: true, email: true,
        checkInCode: true, qrToken: true, checkInStatus: true, checkedInAt: true
      }
    });
    if (!attendee) throw new AppError(404, "ATTENDEE_NOT_FOUND", "找不到報名資料");
    return attendee;
  },

  async importFromExcel(eventId: string, fileBuffer: Buffer, userId: string) {
    await eventService.get(eventId);

    const rows = await readXlsxFile(fileBuffer);
    if (rows.length < 2) throw new AppError(400, "EMPTY_IMPORT", "匯入檔案沒有資料");

    const header = rows[0].map((cell) => String(cell ?? "").trim().toLowerCase());
    const col = (names: string[]) => header.findIndex((h) => names.includes(h));

    const nameIdx = col(["name", "姓名"]);
    const phoneIdx = col(["phone", "電話", "手機"]);
    const emailIdx = col(["email", "信箱"]);
    const ageIdx = col(["age", "年齡"]);
    const genderIdx = col(["gender", "性別"]);

    if (nameIdx < 0 || phoneIdx < 0) {
      throw new AppError(400, "INVALID_COLUMNS", "Excel 需包含姓名與電話欄位");
    }

    const attendees = rows
      .slice(1)
      .map((row, index) => ({
        eventId,
        name: String(row[nameIdx] ?? "").trim(),
        phone: String(row[phoneIdx] ?? "").trim(),
        email: emailIdx >= 0 ? (String(row[emailIdx] ?? "").trim() || undefined) : undefined,
        age: ageIdx >= 0 ? (Number(row[ageIdx]) || undefined) : undefined,
        gender: genderIdx >= 0 ? parseGender(String(row[genderIdx] ?? "")) : undefined,
        checkInCode: createCheckInCode(index),
        qrToken: createQrToken()
      }))
      .filter((row) => row.name && row.phone);

    if (attendees.length === 0) throw new AppError(400, "EMPTY_IMPORT", "沒有有效的報名資料");

    await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { attendeeCredits: true } });
      if (!user) throw new AppError(404, "USER_NOT_FOUND", "找不到使用者");
      if (user.attendeeCredits < attendees.length) {
        throw new AppError(
          402,
          "INSUFFICIENT_ATTENDEE_CREDITS",
          `報到人數額度不足。需要 ${attendees.length} 個額度，目前剩餘 ${user.attendeeCredits} 個。`
        );
      }

      await tx.user.update({
        where: { id: userId },
        data: { attendeeCredits: { decrement: attendees.length } }
      });

      await tx.attendee.createMany({ data: attendees });
    });

    return { imported: attendees.length };
  },

  async exportCsv(eventId: string) {
    const attendees = await attendeeRepository.list(eventId);
    const successLogs = await prisma.checkInLog.findMany({
      where: { eventId, status: CheckInLogStatus.SUCCESS },
      orderBy: { createdAt: "desc" }
    });
    const latestMethod = new Map(
      successLogs.filter((l) => l.attendeeId).map((l) => [l.attendeeId, l.method])
    );
    const header = ["姓名", "電話", "Email", "年齡", "性別", "報到狀態", "報到時間", "報到方式"];
    const rows = attendees.map((a) => [
      a.name, a.phone,
      (a as { email?: string | null }).email ?? "",
      (a as { age?: number | null }).age ?? "",
      (a as { gender?: string | null }).gender ?? "",
      a.checkInStatus,
      a.checkedInAt?.toISOString() ?? "",
      latestMethod.get(a.id) ?? ""
    ]);
    return [header, ...rows].map((row) => row.map(toCsvCell).join(",")).join("\n");
  },

  async update(
    eventId: string,
    attendeeId: string,
    input: Partial<{
      name: string;
      phone: string;
      email: string | null;
      age: number | null;
      gender: Gender | null;
      checkInStatus: CheckInStatus;
      checkedInAt: string | null;
    }>
  ) {
    const attendee = await attendeeRepository.findById(attendeeId);
    if (!attendee || attendee.eventId !== eventId) throw new AppError(404, "ATTENDEE_NOT_FOUND", "找不到報名資料");
    return attendeeRepository.update(attendeeId, {
      name: input.name,
      phone: input.phone,
      checkInStatus: input.checkInStatus,
      checkedInAt: input.checkedInAt === null ? null : input.checkedInAt ? new Date(input.checkedInAt) : undefined
    });
  }
};
