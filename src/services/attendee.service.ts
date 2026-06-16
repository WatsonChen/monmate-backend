import { randomBytes } from "node:crypto";
import { CheckInLogStatus, CheckInStatus, Gender } from "@prisma/client";
import * as XLSX from "xlsx";
import { toCsvCell } from "@monmate/utils";
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

  async createSingle(eventId: string, userId: string, input: { name: string; phone: string; capacity?: number }) {
    await eventService.get(eventId);
    const checkInCode = createCheckInCode(0);
    const qrToken = createQrToken();
    const checkInCapacity = Math.max(1, input.capacity ?? 1);

    return prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { attendeeCredits: true } });
      if (!user) throw new AppError(404, "USER_NOT_FOUND", "找不到使用者");
      if (user.attendeeCredits < 1) {
        throw new AppError(402, "INSUFFICIENT_ATTENDEE_CREDITS", "報到人數額度不足，請購買額度。");
      }
      await tx.user.update({ where: { id: userId }, data: { attendeeCredits: { decrement: 1 } } });
      return tx.attendee.create({
        data: { eventId, name: input.name.trim(), phone: input.phone.trim(), checkInCapacity, checkInCode, qrToken },
        select: { id: true, eventId: true, name: true, phone: true, checkInCode: true, qrToken: true, checkInStatus: true, checkedInAt: true, checkInCapacity: true, checkInCount: true }
      });
    });
  },

  async importFromFile(eventId: string, fileBuffer: Buffer, userId: string) {
    await eventService.get(eventId);

    const workbook = XLSX.read(fileBuffer, { type: "buffer", cellText: false, cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });

    if (rows.length < 2) throw new AppError(400, "EMPTY_IMPORT", "匯入檔案沒有資料");

    const rawHeader = (rows[0] as unknown[]).map((cell) => String(cell ?? "").trim());
    const header = rawHeader.map((h) => h.toLowerCase());
    const col = (names: string[]) => header.findIndex((h) => names.includes(h));

    const nameIdx  = col(["name", "姓名"]);
    const phoneIdx = col(["phone", "電話", "手機"]);
    const emailIdx = col(["email", "信箱"]);
    const ageIdx   = col(["age", "年齡"]);
    const genderIdx = col(["gender", "性別"]);

    if (nameIdx < 0 || phoneIdx < 0) {
      throw new AppError(400, "INVALID_COLUMNS", "檔案需包含「姓名」與「電話」欄位");
    }

    // 偵測人數欄：攜伴人數（需+1）或報名人數（直接用）
    const capacityColIdx = rawHeader.findIndex((h) =>
      /攜伴|companion|報名人數|參加人數|人數/i.test(h)
    );
    const isCompanionCol = capacityColIdx >= 0 && /攜伴|companion/i.test(rawHeader[capacityColIdx]);

    function parseCapacityValue(raw: string, isCompanion: boolean): number {
      const n = parseInt(raw, 10);
      if (isNaN(n) || n <= 0) return 1;
      // 攜伴人數欄：加本人；報名人數欄：直接使用
      return isCompanion ? n + 1 : n;
    }

    const knownIdx = new Set(
      [nameIdx, phoneIdx, emailIdx, ageIdx, genderIdx, capacityColIdx].filter((i) => i >= 0)
    );
    const extraCols = rawHeader
      .map((label, i) => ({ label, i }))
      .filter(({ i }) => !knownIdx.has(i) && rawHeader[i]);

    const attendees = rows
      .slice(1)
      .map((row, index) => {
        const r = row as unknown[];
        const customFields: Record<string, string> = {};
        for (const { label, i } of extraCols) {
          const val = String(r[i] ?? "").trim();
          if (val) customFields[label] = val;
        }
        const checkInCapacity = capacityColIdx >= 0
          ? parseCapacityValue(String(r[capacityColIdx] ?? "").trim(), isCompanionCol)
          : 1;
        return {
          eventId,
          name:  String(r[nameIdx]  ?? "").trim(),
          phone: String(r[phoneIdx] ?? "").trim(),
          email:   emailIdx  >= 0 ? (String(r[emailIdx]  ?? "").trim() || undefined) : undefined,
          age:     ageIdx    >= 0 ? (Number(r[ageIdx])   || undefined) : undefined,
          gender:  genderIdx >= 0 ? parseGender(String(r[genderIdx] ?? "")) : undefined,
          customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
          checkInCapacity,
          checkInCode: createCheckInCode(index),
          qrToken: createQrToken()
        };
      })
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
      await tx.user.update({ where: { id: userId }, data: { attendeeCredits: { decrement: attendees.length } } });
      await tx.attendee.createMany({ data: attendees });
    });

    return { imported: attendees.length };
  },

  async exportCsv(eventId: string) {
    const { header, rows } = await this._buildExportData(eventId);
    return [header, ...rows].map((row) => row.map(toCsvCell).join(",")).join("\n");
  },

  async exportXlsx(eventId: string): Promise<Buffer> {
    const { header, rows } = await this._buildExportData(eventId);
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Attendees");
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  },

  async _buildExportData(eventId: string) {
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
    return { header, rows };
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
  },

  async completeRegistration(
    eventId: string,
    qrToken: string,
    input: {
      name: string;
      email?: string;
      age?: number;
      gender?: "M" | "F" | "OTHER";
      customFields?: Record<string, string | number>;
    }
  ) {
    const attendee = await attendeeRepository.findByQrToken(eventId, qrToken);
    if (!attendee) throw new AppError(404, "ATTENDEE_NOT_FOUND", "找不到報名資料，請確認連結是否正確");
    return prisma.attendee.update({
      where: { id: attendee.id },
      data: {
        name: input.name,
        email: input.email || null,
        age: input.age ?? null,
        gender: input.gender ?? null,
        customFields: input.customFields ?? undefined
      },
      select: { id: true, name: true, phone: true, checkInCode: true, qrToken: true, checkInStatus: true }
    });
  }
};
