import { randomBytes, randomInt } from "node:crypto";
import { CheckInLogStatus, CheckInStatus, Gender, Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { toCsvCell } from "@monmate/utils";
import { AppError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { attendeeRepository } from "../repositories/attendee.repository.js";
import { eventService } from "./event.service.js";

// 排除易混淆字元 0/O、1/I/L
const CHECKIN_CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CHECKIN_CODE_LENGTH = 5;

function randomCheckInCode() {
  let code = "";
  for (let i = 0; i < CHECKIN_CODE_LENGTH; i++) {
    code += CHECKIN_CODE_CHARS[randomInt(CHECKIN_CODE_CHARS.length)];
  }
  return code;
}

function isCheckInCodeConflict(err: unknown) {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002" &&
    (err.meta?.target as string[] | undefined)?.includes("checkInCode")
  );
}

// 重試以避開極少數的隨機碼碰撞（DB 有 eventId+checkInCode 唯一限制）
export async function createAttendeeWithUniqueCode<T>(create: (checkInCode: string) => Promise<T>): Promise<T> {
  const maxAttempts = 5;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await create(randomCheckInCode());
    } catch (err) {
      if (!isCheckInCodeConflict(err) || attempt === maxAttempts - 1) throw err;
    }
  }
  throw new Error("unreachable");
}

// 匯入時一次生成整批不重複的碼（含比對同活動內既有的碼）
async function generateUniqueCheckInCodes(eventId: string, count: number): Promise<string[]> {
  const used = new Set(
    (await prisma.attendee.findMany({ where: { eventId }, select: { checkInCode: true } })).map((a) => a.checkInCode)
  );
  const codes: string[] = [];
  while (codes.length < count) {
    const code = randomCheckInCode();
    if (used.has(code)) continue;
    used.add(code);
    codes.push(code);
  }
  return codes;
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
    const qrToken = createQrToken();
    const checkInCapacity = Math.max(1, input.capacity ?? 1);

    return prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { attendeeCredits: true } });
      if (!user) throw new AppError(404, "USER_NOT_FOUND", "找不到使用者");
      if (user.attendeeCredits < 1) {
        throw new AppError(402, "INSUFFICIENT_ATTENDEE_CREDITS", "報到人數額度不足，請購買額度。");
      }
      await tx.user.update({ where: { id: userId }, data: { attendeeCredits: { decrement: 1 } } });
      return createAttendeeWithUniqueCode((checkInCode) =>
        tx.attendee.create({
          data: { eventId, name: input.name.trim(), phone: input.phone.trim(), checkInCapacity, checkInCode, qrToken },
          select: { id: true, eventId: true, name: true, phone: true, checkInCode: true, qrToken: true, checkInStatus: true, checkedInAt: true, checkInCapacity: true, checkInCount: true }
        })
      );
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

    const dataRows = rows.slice(1);
    const checkInCodes = await generateUniqueCheckInCodes(eventId, dataRows.length);

    const attendees = dataRows
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
          checkInCode: checkInCodes[index],
          qrToken: createQrToken()
        };
      })
      .filter((row) => row.name && row.phone);

    if (attendees.length === 0) throw new AppError(400, "EMPTY_IMPORT", "沒有有效的報名資料");

    await prisma.$transaction(async (tx) => {
      const existingPhoneMap = new Map(
        (await tx.attendee.findMany({ where: { eventId, phone: { in: attendees.map((a) => a.phone) } }, select: { id: true, phone: true } }))
          .map((a) => [a.phone, a.id])
      );

      const toCreate = attendees.filter((a) => !existingPhoneMap.has(a.phone));
      const toUpdate = attendees.filter((a) => existingPhoneMap.has(a.phone));

      const user = await tx.user.findUnique({ where: { id: userId }, select: { attendeeCredits: true } });
      if (!user) throw new AppError(404, "USER_NOT_FOUND", "找不到使用者");
      if (user.attendeeCredits < toCreate.length) {
        throw new AppError(
          402,
          "INSUFFICIENT_ATTENDEE_CREDITS",
          `報到人數額度不足。需要 ${toCreate.length} 個額度，目前剩餘 ${user.attendeeCredits} 個。`
        );
      }
      if (toCreate.length > 0) {
        await tx.user.update({ where: { id: userId }, data: { attendeeCredits: { decrement: toCreate.length } } });
        await tx.attendee.createMany({ data: toCreate });
      }
      for (const a of toUpdate) {
        await tx.attendee.update({
          where: { id: existingPhoneMap.get(a.phone)! },
          data: { checkInCapacity: a.checkInCapacity, customFields: a.customFields ?? undefined }
        });
      }
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
    const [event, attendees] = await Promise.all([
      eventService.get(eventId),
      attendeeRepository.list(eventId)
    ]);
    const successLogs = await prisma.checkInLog.findMany({
      where: { eventId, status: CheckInLogStatus.SUCCESS },
      orderBy: { createdAt: "desc" }
    });
    const latestMethod = new Map(
      successLogs.filter((l) => l.attendeeId).map((l) => [l.attendeeId, l.method])
    );

    const presetKeys = new Set(["email", "age", "gender", "capacity"]);
    const configCustomFields = (event.registrationFields ?? []).filter((f) => !presetKeys.has(f.key));
    const customKeys = new Set<string>(configCustomFields.map((f) => f.key));
    for (const a of attendees) {
      const cf = (a.customFields ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(cf)) customKeys.add(k);
    }
    const customKeyList = Array.from(customKeys);
    const customLabel = (key: string) => configCustomFields.find((f) => f.key === key)?.label || key;

    const header = ["姓名", "電話", "Email", "年齡", "性別", "報到碼", "報名人數", "實際報到人數", "報到狀態", "報到時間", "報到方式", "備註", ...customKeyList.map(customLabel)];
    const rows = attendees.map((a) => {
      const cf = (a.customFields ?? {}) as Record<string, unknown>;
      return [
        a.name, a.phone,
        (a as { email?: string | null }).email ?? "",
        (a as { age?: number | null }).age ?? "",
        (a as { gender?: string | null }).gender ?? "",
        a.checkInCode,
        a.checkInCapacity,
        a.checkInCount,
        a.checkInStatus,
        a.checkedInAt?.toISOString() ?? "",
        latestMethod.get(a.id) ?? "",
        a.note ?? "",
        ...customKeyList.map((k) => cf[k] ?? "")
      ];
    });
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
      checkInCapacity: number;
      checkInCount: number;
      customFields: Record<string, string | number> | null;
      note: string | null;
    }>
  ) {
    const attendee = await attendeeRepository.findById(attendeeId);
    if (!attendee || attendee.eventId !== eventId) throw new AppError(404, "ATTENDEE_NOT_FOUND", "找不到報名資料");
    return attendeeRepository.update(attendeeId, {
      name: input.name,
      phone: input.phone,
      email: input.email === undefined ? undefined : input.email,
      age: input.age === undefined ? undefined : input.age,
      gender: input.gender === undefined ? undefined : input.gender,
      checkInStatus: input.checkInStatus,
      checkedInAt: input.checkedInAt === null ? null : input.checkedInAt ? new Date(input.checkedInAt) : undefined,
      checkInCapacity: input.checkInCapacity,
      checkInCount: input.checkInCount,
      customFields: input.customFields === undefined ? undefined : input.customFields ?? Prisma.JsonNull,
      note: input.note === undefined ? undefined : input.note
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
      capacity?: number;
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
        checkInCapacity: input.capacity ?? undefined,
        customFields: input.customFields ?? undefined
      },
      select: { id: true, name: true, phone: true, checkInCode: true, qrToken: true, checkInStatus: true }
    });
  }
};
