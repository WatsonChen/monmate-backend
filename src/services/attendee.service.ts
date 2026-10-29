import { randomBytes, randomInt } from "node:crypto";
import { CheckInLogStatus, CheckInStatus, Gender, Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { toCsvCell } from "@monmate/utils";
import { AppError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { attendeeRepository } from "../repositories/attendee.repository.js";
import { chargeWallet } from "./credit-wallet.service.js";
import { eventService } from "./event.service.js";

// 排除易混淆字元 0/O、1/I/L
const CHECKIN_CODE_CHARS = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CHECKIN_CODE_LENGTH = 5;

// 公開報名頁單一報名者（含攜伴）人數上限
export const PUBLIC_MAX_CAPACITY = 20;

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
export async function generateUniqueCheckInCodes(
  eventId: string,
  count: number,
  db: Pick<Prisma.TransactionClient, "attendee"> = prisma
): Promise<string[]> {
  const used = new Set(
    (await db.attendee.findMany({ where: { eventId }, select: { checkInCode: true } })).map((a) => a.checkInCode)
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

export function createQrToken() {
  return randomBytes(18).toString("base64url");
}

export function parseGender(value: string | null | undefined): Gender | undefined {
  const v = String(value ?? "").trim().toUpperCase();
  if (v === "M" || v === "男") return Gender.M;
  if (v === "F" || v === "女") return Gender.F;
  if (v === "OTHER" || v === "其他") return Gender.OTHER;
  return undefined;
}

// 調高人數（含攜伴）時，補扣差額並寫入帳本；調低不退（與匯入規則一致）。
// 一律在呼叫端的 transaction 內執行，餘額不足時整筆拒絕。
async function chargeCapacityIncrease(
  tx: Prisma.TransactionClient,
  params: { ownerId: string; eventId: string; attendeeId: string; delta: number; note: string }
) {
  const { ownerId, eventId, attendeeId, delta, note } = params;
  if (delta <= 0) return;
  await chargeWallet(tx, { userId: ownerId, amount: delta, reason: "ATTENDEE_CREATE", eventId, attendeeId, note });
}

// 未開放超額時，調高人數不得超過活動人數上限
async function assertCapacityRoom(
  tx: Prisma.TransactionClient,
  event: { attendeeLimit: number | null; allowOverCapacity: boolean },
  eventId: string,
  delta: number
) {
  if (event.allowOverCapacity || !event.attendeeLimit || delta <= 0) return;
  const agg = await tx.attendee.aggregate({ where: { eventId }, _sum: { checkInCapacity: true } });
  const headcount = agg._sum.checkInCapacity ?? 0;
  if (headcount + delta > event.attendeeLimit) {
    throw new AppError(409, "CAPACITY_FULL", `已達人數上限（上限 ${event.attendeeLimit} 人、現有 ${headcount} 人）。`);
  }
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

  async createSingle(eventId: string, userId: string, input: { name: string; phone: string; email?: string; capacity?: number }) {
    const event = await eventService.get(eventId);
    const qrToken = createQrToken();
    const checkInCapacity = Math.max(1, input.capacity ?? 1);

    return prisma.$transaction(async (tx) => {
      // 未開放超額時，用人頭（checkInCapacity 加總）判斷是否超過人數上限
      if (!event.allowOverCapacity && event.attendeeLimit) {
        const agg = await tx.attendee.aggregate({ where: { eventId }, _sum: { checkInCapacity: true } });
        const headcount = agg._sum.checkInCapacity ?? 0;
        if (headcount + checkInCapacity > event.attendeeLimit) {
          throw new AppError(
            409,
            "CAPACITY_FULL",
            `已達人數上限（上限 ${event.attendeeLimit} 人、現有 ${headcount} 人）。如需超額，請於活動設定開啟「允許超額報名」。`
          );
        }
      }

      const attendee = await createAttendeeWithUniqueCode((checkInCode) =>
        tx.attendee.create({
          data: { eventId, name: input.name.trim(), phone: input.phone.trim(), email: input.email?.trim() || null, checkInCapacity, checkInCode, qrToken },
          select: { id: true, eventId: true, name: true, phone: true, email: true, checkInCode: true, qrToken: true, checkInStatus: true, checkedInAt: true, checkInCapacity: true, checkInCount: true }
        })
      );
      // 按人頭扣點：一筆報名者含攜伴需扣 checkInCapacity 個額度；扣點與建立名單同一個 transaction
      await chargeWallet(tx, { userId, amount: checkInCapacity, reason: "ATTENDEE_CREATE", eventId, attendeeId: attendee.id });
      return attendee;
    });
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

    const header = ["姓名", "電話", "Email", "年齡", "性別", "報到碼", "報名人數", "實際報到人數", "報到狀態", "報到時間", "報到方式", "備註", "報名編號", ...customKeyList.map(customLabel)];
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
        a.id,
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

    const data = {
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
    };

    const delta = input.checkInCapacity === undefined ? 0 : input.checkInCapacity - attendee.checkInCapacity;
    if (delta <= 0) return attendeeRepository.update(attendeeId, data);

    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { createdById: true, attendeeLimit: true, allowOverCapacity: true }
    });
    if (!event) throw new AppError(404, "EVENT_NOT_FOUND", "找不到活動");

    return prisma.$transaction(async (tx) => {
      await assertCapacityRoom(tx, event, eventId, delta);
      await chargeCapacityIncrease(tx, {
        ownerId: event.createdById, eventId, attendeeId, delta, note: "調高人數"
      });
      return tx.attendee.update({ where: { id: attendeeId }, data });
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

    // 公開頁只能「調高」人數（含攜伴），不能調低再重填，避免重複扣點；每人上限 PUBLIC_MAX_CAPACITY
    const requested = Math.min(input.capacity ?? attendee.checkInCapacity, PUBLIC_MAX_CAPACITY);
    const nextCapacity = Math.max(attendee.checkInCapacity, requested);
    const delta = nextCapacity - attendee.checkInCapacity;

    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { createdById: true, attendeeLimit: true, allowOverCapacity: true }
    });
    if (!event) throw new AppError(404, "EVENT_NOT_FOUND", "找不到活動");

    return prisma.$transaction(async (tx) => {
      try {
        await assertCapacityRoom(tx, event, eventId, delta);
      } catch (err) {
        // 不對參加者揭露活動的人數上限與目前報名人數
        if (err instanceof AppError && err.code === "CAPACITY_FULL") throw new AppError(409, "CAPACITY_FULL", "此活動報名名額已滿");
        throw err;
      }
      // 攜伴加人由主辦點數支付；餘額不足時整筆更新被拒絕（delta 為 0 時不扣點、不受影響）。
      // 參加者看不到主辦的餘額或帳務資訊，只會得到一般的「無法完成報名」。
      try {
        await chargeCapacityIncrease(tx, {
          ownerId: event.createdById, eventId, attendeeId: attendee.id, delta, note: "公開報名攜伴"
        });
      } catch (err) {
        if (err instanceof AppError && err.code === "INSUFFICIENT_ATTENDEE_CREDITS") {
          throw new AppError(409, "REGISTRATION_UNAVAILABLE", "目前無法完成報名，請聯絡主辦單位");
        }
        throw err;
      }
      return tx.attendee.update({
        where: { id: attendee.id },
        data: {
          name: input.name,
          email: input.email || null,
          age: input.age ?? null,
          gender: input.gender ?? null,
          checkInCapacity: delta > 0 ? nextCapacity : undefined,
          customFields: input.customFields ?? undefined
        },
        select: { id: true, name: true, phone: true, checkInCode: true, qrToken: true, checkInStatus: true }
      });
    });
  }
};
