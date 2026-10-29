import { prisma } from "../lib/prisma.js";

const JOB = "purge-expired";

type PurgeOptions = { batchSize?: number; maxBatches?: number; deadlineMs?: number };

// 每次最多刪 batchSize 筆，且用 FOR UPDATE SKIP LOCKED 跳過被鎖住的列：
// 正在確認匯入（持有該列鎖）的預覽不會被刪，也不會讓清理卡住等待。
// 條件寫死為「PREVIEW 且已過期」，已確認的匯入摘要永遠不會被這裡刪除。
async function purgeImportSessionsBatch(batchSize: number, now: Date) {
  return prisma.$executeRaw`
    DELETE FROM "ImportSession"
    WHERE "id" IN (
      SELECT "id" FROM "ImportSession"
      WHERE "status" = 'PREVIEW'::"ImportSessionStatus" AND "expiresAt" < ${now.toISOString()}::timestamp
      ORDER BY "expiresAt"
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    )`;
}

async function purgeCountersBatch(batchSize: number, now: Date) {
  return prisma.$executeRaw`
    DELETE FROM "RateLimitCounter"
    WHERE ctid IN (SELECT ctid FROM "RateLimitCounter" WHERE "expiresAt" < ${now.toISOString()}::timestamp LIMIT ${batchSize})`;
}

async function purgeOldRunsBatch(batchSize: number, olderThan: Date) {
  return prisma.$executeRaw`
    DELETE FROM "MaintenanceRun"
    WHERE "id" IN (SELECT "id" FROM "MaintenanceRun" WHERE "startedAt" < ${olderThan.toISOString()}::timestamp LIMIT ${batchSize})`;
}

async function drain(step: (batchSize: number) => Promise<number>, batchSize: number, maxBatches: number, deadline: number) {
  let total = 0;
  let batches = 0;
  let more = false;
  while (batches < maxBatches && Date.now() < deadline) {
    const n = await step(batchSize);
    batches++;
    total += n;
    if (n < batchSize) return { total, batches, more: false };
    more = true;
  }
  return { total, batches, more };
}

export const maintenanceService = {
  // 可重複執行：沒有東西可清就什麼都不做。分批，並有時間與批次上限，剩下的留給下一次。
  async purgeExpired(options: PurgeOptions = {}) {
    const batchSize = options.batchSize ?? 500;
    const maxBatches = options.maxBatches ?? 20;
    const deadline = Date.now() + (options.deadlineMs ?? 20_000);
    const now = new Date();

    const run = await prisma.maintenanceRun.create({ data: { job: JOB } });
    try {
      const sessions = await drain((n) => purgeImportSessionsBatch(n, now), batchSize, maxBatches, deadline);
      const counters = await drain((n) => purgeCountersBatch(n, now), batchSize, maxBatches, deadline);
      // 維護紀錄本身保留 90 天
      const oldRuns = await drain(
        (n) => purgeOldRunsBatch(n, new Date(now.getTime() - 90 * 24 * 3600_000)),
        batchSize,
        maxBatches,
        deadline
      );
      const result = {
        importSessionsDeleted: sessions.total,
        rateLimitCountersDeleted: counters.total,
        oldRunsDeleted: oldRuns.total,
        moreRemaining: sessions.more || counters.more || oldRuns.more
      };
      await prisma.maintenanceRun.update({ where: { id: run.id }, data: { ok: true, finishedAt: new Date(), result } });
      return result;
    } catch (err) {
      await prisma.maintenanceRun
        .update({ where: { id: run.id }, data: { ok: false, finishedAt: new Date(), result: { error: String(err).slice(0, 300) } } })
        .catch(() => undefined);
      throw err;
    }
  }
};
