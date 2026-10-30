import { createHash } from "node:crypto";
import { CREDIT_FLOOR } from "../config/credit.js";
import { type Gender, ImportSessionStatus, Prisma } from "@prisma/client";
import * as XLSX from "xlsx";
import { AppError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { createQrToken, generateUniqueCheckInCodes, parseGender } from "./attendee.service.js";
import { chargeWallet } from "./credit-wallet.service.js";

export const MAX_IMPORT_ROWS = 5000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
// 付款期間可延長暫存，但從建立起算最長 48 小時，不能無限續期
const SESSION_MAX_LIFETIME_MS = 48 * 60 * 60 * 1000;
const PAYMENT_EXTENSION_MS = 2 * 60 * 60 * 1000;
const MAX_ROW_CAPACITY = 999;
const EXPORT_ONLY_COLUMNS = new Set(["報到碼", "實際報到人數", "報到狀態", "報到時間", "報到方式"]);

export type ParsedRow = {
  rowNumber: number;
  id?: string;
  name: string;
  phone: string;
  email?: string;
  age?: number;
  gender?: Gender;
  note?: string;
  capacity: number;
  customFields?: Record<string, string>;
};
export type RowError = { rowNumber: number; field: string; reason: string };
export type DecisionAction = "UPDATE" | "NEW" | "SKIP";
export type Decision = { action: DecisionAction; targetId?: string };
export type DecisionMap = Record<string, Decision>;

export type ExistingAttendee = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  age: number | null;
  gender: Gender | null;
  note: string | null;
  checkInCapacity: number;
  customFields: Prisma.JsonValue;
};

import { normalizeName, normalizePhone } from "../lib/identity.js";
export { normalizeName, normalizePhone };
const nameKey = (name: string, phone: string) => `${normalizeName(name)}|${normalizePhone(phone)}`;

// ---------- 解析 ----------

export function parseImportFile(fileBuffer: Buffer) {
  let rows: unknown[][];
  try {
    // raw: CSV 內容保留原始文字，否則電話 0912… 會被當成數字而吃掉開頭的 0
    const workbook = XLSX.read(fileBuffer, { type: "buffer", cellText: false, cellDates: true, raw: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1 });
  } catch {
    throw new AppError(400, "INVALID_FILE", "無法讀取檔案，請確認是 Excel 或 CSV 格式");
  }
  if (rows.length < 2) throw new AppError(400, "EMPTY_IMPORT", "匯入檔案沒有資料");

  const rawHeader = (rows[0] as unknown[]).map((cell) => String(cell ?? "").trim());
  const header = rawHeader.map((h) => h.toLowerCase());
  const col = (names: string[]) => header.findIndex((h) => names.includes(h));

  const nameIdx = col(["name", "姓名"]);
  const phoneIdx = col(["phone", "電話", "手機"]);
  const emailIdx = col(["email", "信箱"]);
  const ageIdx = col(["age", "年齡"]);
  const genderIdx = col(["gender", "性別"]);
  const idIdx = col(["報名編號", "id", "attendeeid", "attendee id"]);
  const noteIdx = col(["備註", "note"]);
  if (nameIdx < 0 || phoneIdx < 0) {
    throw new AppError(400, "INVALID_COLUMNS", "檔案需包含「姓名」與「電話」欄位");
  }

  // 人數欄：攜伴人數（需 +1）或報名人數（直接用）。「實際報到人數」是匯出的統計欄，不當作報名人數
  const capacityColIdx = rawHeader.findIndex((h) => !/實際/.test(h) && /攜伴|companion|報名人數|參加人數|人數/i.test(h));
  const isCompanionCol = capacityColIdx >= 0 && /攜伴|companion/i.test(rawHeader[capacityColIdx]);

  // 匯出檔裡的系統統計欄，匯入時略過，讓匯出檔可以原樣重新匯入
  const exportOnlyIdx = rawHeader.map((h, i) => (EXPORT_ONLY_COLUMNS.has(h) ? i : -1)).filter((i) => i >= 0);
  const knownIdx = new Set(
    [nameIdx, phoneIdx, emailIdx, ageIdx, genderIdx, capacityColIdx, idIdx, noteIdx, ...exportOnlyIdx].filter((i) => i >= 0)
  );
  const extraCols = rawHeader.map((label, i) => ({ label, i })).filter(({ i }) => !knownIdx.has(i) && rawHeader[i]);

  const dataRows = rows.slice(1);
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new AppError(400, "TOO_MANY_ROWS", `單次最多匯入 ${MAX_IMPORT_ROWS} 列，請分批匯入`);
  }

  const parsed: ParsedRow[] = [];
  const errors: RowError[] = [];
  let totalRows = 0;

  dataRows.forEach((raw, index) => {
    const r = raw as unknown[];
    if (r.every((c) => String(c ?? "").trim() === "")) return; // 空白列不計
    totalRows += 1;
    const rowNumber = index + 2; // Excel 列號：標題列為第 1 列
    const cell = (i: number) => (i >= 0 ? String(r[i] ?? "").trim() : "");

    const name = cell(nameIdx);
    const phone = cell(phoneIdx);
    let bad = false;
    if (!name) { errors.push({ rowNumber, field: header[nameIdx] ? rawHeader[nameIdx] : "姓名", reason: "姓名不能空白" }); bad = true; }
    if (!phone) { errors.push({ rowNumber, field: rawHeader[phoneIdx], reason: "電話不能空白" }); bad = true; }

    let capacity = 1;
    if (capacityColIdx >= 0) {
      const rawCap = cell(capacityColIdx);
      if (rawCap !== "") {
        const n = Number(rawCap);
        const min = isCompanionCol ? 0 : 1;
        if (!Number.isInteger(n) || n < min || n + (isCompanionCol ? 1 : 0) > MAX_ROW_CAPACITY) {
          errors.push({
            rowNumber,
            field: rawHeader[capacityColIdx],
            reason: isCompanionCol ? "攜伴人數需為 0 以上的整數" : "人數需為 1 以上的整數"
          });
          bad = true;
        } else {
          capacity = isCompanionCol ? n + 1 : n;
        }
      }
    }
    if (bad) return;

    const customFields: Record<string, string> = {};
    for (const { label, i } of extraCols) {
      const val = cell(i);
      if (val) customFields[label] = val;
    }
    const age = ageIdx >= 0 ? Number(r[ageIdx]) : NaN;
    parsed.push({
      rowNumber,
      id: idIdx >= 0 ? cell(idIdx) || undefined : undefined,
      name,
      phone,
      email: cell(emailIdx) || undefined,
      age: Number.isInteger(age) && age > 0 ? age : undefined,
      gender: genderIdx >= 0 ? parseGender(cell(genderIdx)) : undefined,
      note: cell(noteIdx) || undefined,
      capacity,
      customFields: Object.keys(customFields).length > 0 ? customFields : undefined
    });
  });

  return { rows: parsed, errors, totalRows };
}

// ---------- 逐筆比對（純函式，不碰資料庫） ----------

export type Candidate = { id: string; name: string; phone: string };
export type RowOutcome =
  | { rowNumber: number; kind: "DUPLICATE_IN_FILE" }
  | { rowNumber: number; kind: "UNCHANGED"; targetId: string }
  | { rowNumber: number; kind: "UPDATE"; targetId: string; capacityDelta: number; changedFields: string[]; data: Prisma.AttendeeUncheckedUpdateInput }
  | { rowNumber: number; kind: "NEW"; row: ParsedRow }
  | { rowNumber: number; kind: "SKIPPED" }
  | { rowNumber: number; kind: "SUSPECT"; row: ParsedRow; candidates: Candidate[] };

export function classifyRows(rows: ParsedRow[], existing: ExistingAttendee[], decisions: DecisionMap) {
  // 工作副本：同一筆既有名單被多列命中時，後面的列要拿「已套用前面列之後」的狀態比較，避免重複計費
  const state = new Map(existing.map((e) => [e.id, { ...e }]));
  const byKey = new Map<string, string>();
  const byPhone = new Map<string, string[]>();
  for (const e of existing) {
    const k = nameKey(e.name, e.phone);
    if (!byKey.has(k)) byKey.set(k, e.id);
    const p = normalizePhone(e.phone);
    byPhone.set(p, [...(byPhone.get(p) ?? []), e.id]);
  }

  const seen = new Set<string>();
  const outcomes: RowOutcome[] = [];
  let ignoredIds = 0;
  let suspectTotal = 0;
  const suspectInfos: { rowNumber: number; row: ParsedRow; candidates: Candidate[] }[] = [];

  for (const row of rows) {
    const key = nameKey(row.name, row.phone);
    let target = row.id ? state.get(row.id) : undefined;
    let via: "id" | "exact" | "decision" | undefined = target ? "id" : undefined;
    if (row.id && !target) ignoredIds += 1; // 不屬於本活動的編號一律忽略，不透露是否存在於他處
    if (!target) {
      const tid = byKey.get(key);
      if (tid) { target = state.get(tid); via = "exact"; }
    }

    let forcedNew = false;
    if (!target) {
      const candIds = byPhone.get(normalizePhone(row.phone)) ?? [];
      if (candIds.length > 0) {
        if (seen.has(`np:${key}`)) { outcomes.push({ rowNumber: row.rowNumber, kind: "DUPLICATE_IN_FILE" }); continue; }
        suspectTotal += 1;
        const candidates = candIds.map((id) => ({ id, name: state.get(id)!.name, phone: state.get(id)!.phone }));
        suspectInfos.push({ rowNumber: row.rowNumber, row, candidates });
        const d = decisions[String(row.rowNumber)];
        if (!d) {
          seen.add(`np:${key}`);
          outcomes.push({ rowNumber: row.rowNumber, kind: "SUSPECT", row, candidates });
          continue;
        }
        if (d.action === "SKIP") { seen.add(`np:${key}`); outcomes.push({ rowNumber: row.rowNumber, kind: "SKIPPED" }); continue; }
        if (d.action === "UPDATE" && d.targetId && candIds.includes(d.targetId)) {
          target = state.get(d.targetId);
          via = "decision";
        } else {
          forcedNew = true; // NEW，或 UPDATE 但指定的對象無效時不自動合併，退回待決定
          if (d.action === "UPDATE") {
            seen.add(`np:${key}`);
            outcomes.push({ rowNumber: row.rowNumber, kind: "SUSPECT", row, candidates });
            continue;
          }
        }
      }
    }

    if (!target) {
      if (!forcedNew) {
        if (seen.has(`np:${key}`)) { outcomes.push({ rowNumber: row.rowNumber, kind: "DUPLICATE_IN_FILE" }); continue; }
        seen.add(`np:${key}`);
      }
      outcomes.push({ rowNumber: row.rowNumber, kind: "NEW", row });
      continue;
    }

    if (seen.has(`t:${target.id}`)) { outcomes.push({ rowNumber: row.rowNumber, kind: "DUPLICATE_IN_FILE" }); continue; }
    seen.add(`t:${target.id}`);

    // 已配對：只更新非人數欄位；人數只會調高；空值不覆蓋；報到狀態與紀錄一律不動
    const data: Prisma.AttendeeUncheckedUpdateInput = {};
    const changed: string[] = [];
    if (via !== "exact") {
      if (normalizeName(row.name) !== normalizeName(target.name)) { data.name = row.name; changed.push("姓名"); target.name = row.name; }
      if (normalizePhone(row.phone) !== normalizePhone(target.phone)) { data.phone = row.phone; changed.push("電話"); target.phone = row.phone; }
    }
    if (row.email && row.email !== (target.email ?? "")) { data.email = row.email; changed.push("Email"); target.email = row.email; }
    if (row.age !== undefined && row.age !== target.age) { data.age = row.age; changed.push("年齡"); target.age = row.age; }
    if (row.gender && row.gender !== target.gender) { data.gender = row.gender; changed.push("性別"); target.gender = row.gender; }
    if (row.note && row.note !== (target.note ?? "")) { data.note = row.note; changed.push("備註"); target.note = row.note; }
    if (row.customFields) {
      const current = (target.customFields && typeof target.customFields === "object" && !Array.isArray(target.customFields)
        ? (target.customFields as Record<string, unknown>) : {});
      const merged: Record<string, unknown> = { ...current };
      let diff = false;
      for (const [k, v] of Object.entries(row.customFields)) {
        if (String(current[k] ?? "") !== v) { merged[k] = v; diff = true; }
      }
      if (diff) { data.customFields = merged as Prisma.InputJsonObject; changed.push("自訂欄位"); target.customFields = merged as Prisma.JsonObject; }
    }
    const capacityDelta = Math.max(0, row.capacity - target.checkInCapacity);
    if (capacityDelta > 0) {
      data.checkInCapacity = row.capacity;
      changed.push("人數");
      target.checkInCapacity = row.capacity;
    }

    if (changed.length === 0) outcomes.push({ rowNumber: row.rowNumber, kind: "UNCHANGED", targetId: target.id });
    else outcomes.push({ rowNumber: row.rowNumber, kind: "UPDATE", targetId: target.id, capacityDelta, changedFields: changed, data });
  }

  const count = (k: RowOutcome["kind"]) => outcomes.filter((o) => o.kind === k).length;
  const billableHeadcount = outcomes.reduce(
    (sum, o) => sum + (o.kind === "NEW" ? o.row.capacity : o.kind === "UPDATE" ? o.capacityDelta : 0), 0);
  const suspectPending = count("SUSPECT");
  return {
    outcomes,
    ignoredIds,
    suspectTotal,
    suspectInfos,
    billableHeadcount,
    counts: {
      duplicateInFile: count("DUPLICATE_IN_FILE"),
      unchanged: count("UNCHANGED"),
      toUpdate: count("UPDATE"),
      toCreate: count("NEW"),
      skippedByUser: count("SKIPPED"),
      suspectPending
    },
    costIsFinal: suspectPending === 0
  };
}

// ---------- 預覽 ----------

type DbClient = Prisma.TransactionClient | typeof prisma;

async function assertEventOwner(db: DbClient, eventId: string, userId: string) {
  const event = await db.event.findUnique({
    where: { id: eventId },
    select: { createdById: true, attendeeLimit: true, allowOverCapacity: true }
  });
  // 不是自己的活動一律當作不存在
  if (!event || event.createdById !== userId) throw new AppError(404, "EVENT_NOT_FOUND", "找不到活動");
  return event;
}

async function loadContext(db: DbClient, eventId: string, userId: string) {
  const event = await assertEventOwner(db, eventId, userId);
  const existing = await db.attendee.findMany({
    where: { eventId },
    select: { id: true, name: true, phone: true, email: true, age: true, gender: true, note: true, checkInCapacity: true, customFields: true }
  });
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { attendeeCredits: true } });
  const headcount = existing.reduce((s, a) => s + a.checkInCapacity, 0);
  return { event, existing, headcount, balance: user.attendeeCredits };
}

type SessionRecord = {
  id: string; fileName: string; fileHash: string; rows: unknown; rowErrors: unknown; decisions: unknown;
};

function walletView(balance: number, cost: number) {
  const balanceAfter = balance - cost;
  return {
    balance,
    balanceAfter,
    floor: CREDIT_FLOOR,
    needsTopUp: balanceAfter < CREDIT_FLOOR,
    minTopUp: Math.max(0, CREDIT_FLOOR - balanceAfter)
  };
}

function evaluate(
  session: SessionRecord,
  ctx: Awaited<ReturnType<typeof loadContext>>,
  decisionsOverride?: DecisionMap
) {
  const rows = session.rows as ParsedRow[];
  const errors = session.rowErrors as RowError[];
  const decisions = decisionsOverride ?? (session.decisions as DecisionMap);
  const result = classifyRows(rows, ctx.existing, decisions);
  const { event } = ctx;
  const overLimit = !event.allowOverCapacity && !!event.attendeeLimit && ctx.headcount + result.billableHeadcount > event.attendeeLimit;
  return { rows, errors, decisions, result, overLimit };
}

function toPreview(
  session: SessionRecord,
  ctx: Awaited<ReturnType<typeof loadContext>>,
  ev: ReturnType<typeof evaluate>,
  extra: { previouslyImported?: boolean } = {}
) {
  const { result } = ev;
  const warnings: string[] = [];
  if (result.ignoredIds > 0) warnings.push(`${result.ignoredIds} 列的報名編號不屬於本活動，已改用姓名＋電話比對`);
  if (extra.previouslyImported) warnings.push("此檔案內容先前已在本活動匯入過；系統仍會逐筆比對，重複的人不會再新增或扣點");
  if (ev.overLimit) warnings.push(`匯入後將超過人數上限 ${ctx.event.attendeeLimit} 人，請先在活動設定開啟「允許超額報名」或調整名單`);

  return {
    sessionId: session.id,
    fileName: session.fileName,
    counts: {
      totalRows: ev.rows.length + ev.errors.length,
      errorRows: new Set(ev.errors.map((e) => e.rowNumber)).size,
      ...result.counts,
      suspect: result.suspectTotal
    },
    // 紀錄筆數與計費人數分開：toCreate/toUpdate 是紀錄筆數，billableHeadcount 才是含攜伴的計費人數
    billableHeadcount: result.billableHeadcount,
    costIsFinal: result.costIsFinal,
    wallet: walletView(ctx.balance, result.billableHeadcount),
    capacity: { blocked: ev.overLimit, limit: ctx.event.attendeeLimit ?? null },
    warnings,
    errors: ev.errors.slice(0, 500),
    errorsTruncated: ev.errors.length > 500,
    // 疑似重複清單含已做決定的列，使用者可以回頭改選
    suspects: result.suspectInfos.map((s) => ({
      rowNumber: s.rowNumber,
      name: s.row.name,
      phone: s.row.phone,
      capacity: s.row.capacity,
      candidates: s.candidates,
      decision: (ev.decisions[String(s.rowNumber)] ?? null) as Decision | null
    })),
    previouslyImported: extra.previouslyImported ?? false
  };
}

export type ImportPreview = ReturnType<typeof toPreview>;

export async function purgeExpiredImportSessions() {
  const { count } = await prisma.importSession.deleteMany({
    where: { status: ImportSessionStatus.PREVIEW, expiresAt: { lt: new Date() } }
  });
  return count;
}

async function loadSession(db: DbClient, eventId: string, userId: string, sessionId: string) {
  const session = await db.importSession.findFirst({ where: { id: sessionId, eventId, userId } });
  if (!session) throw new AppError(404, "IMPORT_SESSION_NOT_FOUND", "找不到匯入資料，可能已過期，請重新上傳");
  return session;
}

export const importService = {
  async createPreview(eventId: string, userId: string, fileName: string, fileBuffer: Buffer) {
    await assertEventOwner(prisma, eventId, userId);
    await purgeExpiredImportSessions();

    const { rows, errors, totalRows } = parseImportFile(fileBuffer);
    if (totalRows === 0) throw new AppError(400, "EMPTY_IMPORT", "匯入檔案沒有資料");

    const fileHash = createHash("sha256").update(fileBuffer).digest("hex");
    const previouslyImported =
      (await prisma.importSession.count({ where: { eventId, fileHash, status: ImportSessionStatus.CONFIRMED } })) > 0;

    const session = await prisma.importSession.create({
      data: {
        eventId,
        userId,
        fileName: fileName.slice(0, 200),
        fileHash,
        rows: rows as unknown as Prisma.InputJsonValue,
        rowErrors: errors as unknown as Prisma.InputJsonValue,
        decisions: {},
        expiresAt: new Date(Date.now() + SESSION_TTL_MS)
      }
    });
    const ctx = await loadContext(prisma, eventId, userId);
    return toPreview(session, ctx, evaluate(session, ctx), { previouslyImported });
  },

  async getPreview(eventId: string, userId: string, sessionId: string) {
    const session = await loadSession(prisma, eventId, userId, sessionId);
    if (session.status === ImportSessionStatus.CONFIRMED) {
      return { status: "CONFIRMED" as const, result: session.result };
    }
    if (session.expiresAt < new Date()) throw new AppError(410, "IMPORT_SESSION_EXPIRED", "匯入資料已過期，請重新上傳");
    const ctx = await loadContext(prisma, eventId, userId);
    return { status: "PREVIEW" as const, preview: toPreview(session, ctx, evaluate(session, ctx)) };
  },

  async setDecisions(
    eventId: string,
    userId: string,
    sessionId: string,
    input: { decisions?: DecisionMap; bulk?: "ALL_NEW" | "ALL_SKIP" }
  ) {
    const session = await loadSession(prisma, eventId, userId, sessionId);
    if (session.status !== ImportSessionStatus.PREVIEW) throw new AppError(409, "IMPORT_ALREADY_CONFIRMED", "此匯入已完成");
    if (session.expiresAt < new Date()) throw new AppError(410, "IMPORT_SESSION_EXPIRED", "匯入資料已過期，請重新上傳");

    const ctx = await loadContext(prisma, eventId, userId);
    const merged: DecisionMap = { ...(session.decisions as DecisionMap) };
    const current = classifyRows(session.rows as ParsedRow[], ctx.existing, {});
    const suspects = new Map(
      current.outcomes
        .filter((o): o is Extract<RowOutcome, { kind: "SUSPECT" }> => o.kind === "SUSPECT")
        .map((o) => [String(o.rowNumber), o])
    );

    if (input.bulk) {
      const action: DecisionAction = input.bulk === "ALL_NEW" ? "NEW" : "SKIP";
      for (const key of suspects.keys()) if (!merged[key]) merged[key] = { action };
    }
    for (const [rowNumber, d] of Object.entries(input.decisions ?? {})) {
      const suspect = suspects.get(rowNumber);
      if (!suspect) throw new AppError(400, "INVALID_DECISION", `第 ${rowNumber} 列不是待確認的疑似重複`);
      if (!["UPDATE", "NEW", "SKIP"].includes(d.action)) throw new AppError(400, "INVALID_DECISION", "不支援的處理方式");
      if (d.action === "UPDATE" && !suspect.candidates.some((c) => c.id === d.targetId)) {
        throw new AppError(400, "INVALID_DECISION", `第 ${rowNumber} 列請選擇要更新的既有紀錄`);
      }
      merged[rowNumber] = d.action === "UPDATE" ? { action: "UPDATE", targetId: d.targetId } : { action: d.action };
    }

    const updated = await prisma.importSession.update({
      where: { id: sessionId },
      data: { decisions: merged as unknown as Prisma.InputJsonValue }
    });
    return toPreview(updated, ctx, evaluate(updated, ctx));
  },

  async confirm(
    eventId: string,
    userId: string,
    sessionId: string,
    input: { expectedCost: number; decisions?: DecisionMap }
  ) {
    if (!Number.isInteger(input.expectedCost) || input.expectedCost < 0) {
      throw new AppError(400, "EXPECTED_COST_REQUIRED", "缺少使用者確認過的費用");
    }

    return prisma.$transaction(async (tx) => {
      // 固定鎖定順序：先匯入作業、再活動。同一作業重送會在這裡排隊並讀到第一次的結果；
      // 不同作業含相同名單時，後者會等前者提交後才逐筆比對，因此不會重複新增。
      await tx.$queryRaw`SELECT id FROM "ImportSession" WHERE id = ${sessionId} FOR UPDATE`;
      const session = await loadSession(tx, eventId, userId, sessionId);
      if (session.status === ImportSessionStatus.CONFIRMED) {
        return { status: "CONFIRMED" as const, alreadyConfirmed: true, result: session.result };
      }
      if (session.expiresAt < new Date()) throw new AppError(410, "IMPORT_SESSION_EXPIRED", "匯入資料已過期，請重新上傳");

      await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${eventId} FOR UPDATE`;
      const ctx = await loadContext(tx, eventId, userId);
      const decisions = { ...(session.decisions as DecisionMap), ...(input.decisions ?? {}) };
      const ev = evaluate(session, ctx, decisions);
      const { result } = ev;

      if (!result.costIsFinal) {
        throw new AppError(409, "NEEDS_DECISIONS", `尚有 ${result.counts.suspectPending} 列疑似重複待確認`);
      }
      if (result.billableHeadcount > input.expectedCost) {
        // 名單或規則在預覽後改變，費用變高：不自動執行，回傳新的預覽請使用者重新確認
        return { status: "CHANGED" as const, preview: toPreview(session, ctx, ev) };
      }
      if (ev.overLimit) {
        throw new AppError(409, "CAPACITY_FULL", `匯入後將超過人數上限 ${ctx.event.attendeeLimit} 人，請先開啟「允許超額報名」`);
      }

      const toCreate = result.outcomes.filter((o): o is Extract<RowOutcome, { kind: "NEW" }> => o.kind === "NEW");
      const toUpdate = result.outcomes.filter((o): o is Extract<RowOutcome, { kind: "UPDATE" }> => o.kind === "UPDATE");

      if (toCreate.length > 0) {
        const codes = await generateUniqueCheckInCodes(eventId, toCreate.length, tx);
        await tx.attendee.createMany({
          data: toCreate.map((o, i) => ({
            eventId,
            name: o.row.name,
            phone: o.row.phone,
            email: o.row.email,
            age: o.row.age,
            gender: o.row.gender,
            note: o.row.note,
            customFields: o.row.customFields as Prisma.InputJsonObject | undefined,
            checkInCapacity: o.row.capacity,
            checkInCode: codes[i],
            qrToken: createQrToken()
          }))
        });
      }
      for (const o of toUpdate) {
        await tx.attendee.update({ where: { id: o.targetId }, data: o.data });
      }

      let balanceAfter = ctx.balance;
      if (result.billableHeadcount > 0) {
        ({ balanceAfter } = await chargeWallet(tx, {
          userId,
          amount: result.billableHeadcount,
          reason: "ATTENDEE_IMPORT",
          eventId,
          importSessionId: sessionId,
          note: `匯入 ${session.fileName}：新增 ${toCreate.length} 筆、更新 ${toUpdate.length} 筆`
        }));
      }

      const summary = {
        fileName: session.fileName,
        created: toCreate.length,
        updated: toUpdate.length,
        unchanged: result.counts.unchanged,
        duplicateInFile: result.counts.duplicateInFile,
        skippedByUser: result.counts.skippedByUser,
        errorRows: new Set(ev.errors.map((e) => e.rowNumber)).size,
        billedHeadcount: result.billableHeadcount,
        balanceAfter
      };
      await tx.importSession.update({
        where: { id: sessionId },
        data: {
          status: ImportSessionStatus.CONFIRMED,
          confirmedAt: new Date(),
          rows: [], // 確認後不再保留名單個資，只留結果摘要
          decisions: {},
          result: summary
        }
      });
      return { status: "CONFIRMED" as const, alreadyConfirmed: false, result: summary };
    });
  },

  // 建立付款時，把對應的預覽延長到「現在起 2 小時」，讓使用者付款後能回到同一份預覽；
  // 上限為建立後 48 小時。只延長自己的、尚未過期的預覽，已過期的不會復活。
  async extendForPayment(userId: string, returnTo: string | null | undefined) {
    if (!returnTo) return null;
    let sessionId: string | null = null;
    let eventId: string | null = null;
    try {
      const url = new URL(returnTo, "http://local");
      sessionId = url.searchParams.get("importSession");
      eventId = url.pathname.match(/^\/admin\/events\/([A-Za-z0-9_-]+)$/)?.[1] ?? null;
    } catch {
      return null;
    }
    if (!sessionId || !eventId) return null;

    const session = await prisma.importSession.findFirst({
      where: { id: sessionId, eventId, userId, status: ImportSessionStatus.PREVIEW, expiresAt: { gt: new Date() } }
    });
    if (!session) return null;
    const cap = session.createdAt.getTime() + SESSION_MAX_LIFETIME_MS;
    const next = Math.min(cap, Math.max(session.expiresAt.getTime(), Date.now() + PAYMENT_EXTENSION_MS));
    if (next <= session.expiresAt.getTime()) return session.expiresAt;
    await prisma.importSession.updateMany({
      where: { id: session.id, status: ImportSessionStatus.PREVIEW },
      data: { expiresAt: new Date(next) }
    });
    return new Date(next);
  },

  // 取消預覽：立刻刪除暫存的名單（含個資）。只刪尚未確認的預覽；已確認的紀錄只剩結果摘要，不受影響。
  // 可重複呼叫：找不到或已確認時回傳 discarded: false，不視為錯誤。
  async discard(eventId: string, userId: string, sessionId: string) {
    await assertEventOwner(prisma, eventId, userId);
    const { count } = await prisma.importSession.deleteMany({
      where: { id: sessionId, eventId, userId, status: ImportSessionStatus.PREVIEW }
    });
    return { discarded: count === 1 };
  },

  async listHistory(eventId: string, userId: string) {
    await assertEventOwner(prisma, eventId, userId);
    const sessions = await prisma.importSession.findMany({
      where: { eventId, status: ImportSessionStatus.CONFIRMED },
      orderBy: { confirmedAt: "desc" },
      take: 50,
      select: { id: true, fileName: true, confirmedAt: true, result: true }
    });
    return sessions;
  }
};
