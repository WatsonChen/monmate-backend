import { randomBytes } from "node:crypto";
import * as XLSX from "xlsx";
import { prisma } from "../src/lib/prisma.js";
import { importService } from "../src/services/import.service.js";

const rand = () => randomBytes(4).toString("hex");

export async function resetDb() {
  // 依外鍵順序清空；測試資料庫專用
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "User" RESTART IDENTITY CASCADE'
  );
}

export async function createOwner(credits = 0) {
  return prisma.user.create({
    data: { name: "owner", email: `o-${rand()}@test.local`, passwordHash: "x", role: "ADMIN", attendeeCredits: credits }
  });
}

export async function createEvent(ownerId: string, overrides: Record<string, unknown> = {}) {
  return prisma.event.create({
    data: {
      name: "測試活動",
      slug: `evt-${rand()}`,
      startAt: new Date(Date.now() + 86400000),
      createdById: ownerId,
      openRegistration: true,
      ...overrides
    }
  });
}

export async function balanceOf(userId: string) {
  return (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { attendeeCredits: true } })).attendeeCredits;
}

export function xlsxBuffer(rows: (string | number)[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export const HEADER = ["姓名", "電話"];

export function people(n: number, prefix = "P", startAt = 0): (string | number)[][] {
  return Array.from({ length: n }, (_, i) => [`${prefix}${startAt + i}`, `09${String(10000000 + startAt + i)}`]);
}

export async function previewOf(eventId: string, ownerId: string, rows: (string | number)[][], fileName = "list.xlsx") {
  return importService.createPreview(eventId, ownerId, fileName, xlsxBuffer(rows));
}

// 預覽後以使用者看到的費用確認
export async function runImport(eventId: string, ownerId: string, rows: (string | number)[][], fileName = "list.xlsx") {
  const preview = await previewOf(eventId, ownerId, rows, fileName);
  const outcome = await importService.confirm(eventId, ownerId, preview.sessionId, { expectedCost: preview.billableHeadcount });
  return { preview, outcome };
}
