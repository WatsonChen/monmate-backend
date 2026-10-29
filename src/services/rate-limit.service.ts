import { AppError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";

// 以資料庫為共享儲存的固定視窗計數器。
// - 原子：INSERT ... ON CONFLICT DO UPDATE，並行請求不會漏算
// - 會過期：每筆都有 expiresAt，過期資料由機率式清理與日後的排程移除
// - 成本：每個被保護的請求多 1～3 次單列寫入；視窗內同一個 key 只有一列，資料量不隨請求數成長
export async function hit(key: string, windowSeconds: number): Promise<number> {
  const windowMs = windowSeconds * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  const expiresAt = new Date(windowStart.getTime() + windowMs + 60_000);

  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitCounter" ("key", "windowStart", "count", "expiresAt")
    VALUES (${key}, ${windowStart.toISOString()}::timestamp, 1, ${expiresAt.toISOString()}::timestamp)
    ON CONFLICT ("key", "windowStart")
    DO UPDATE SET "count" = "RateLimitCounter"."count" + 1
    RETURNING "count"`;

  if (Math.random() < 0.01) await purgeExpiredCounters().catch(() => undefined);
  return Number(rows[0].count);
}

// 分批刪除過期計數，可重複執行
export async function purgeExpiredCounters(batch = 500): Promise<number> {
  // 欄位是不含時區的 timestamp（Prisma 以 UTC 存放）：時間以 UTC 字串傳入再轉型，不用資料庫的 now()，
  // 也不直接傳 Date（會被依連線時區換算），否則在非 UTC 的資料庫會整批誤判過期
  const now = new Date();
  const deleted = await prisma.$executeRaw`
    DELETE FROM "RateLimitCounter"
    WHERE ctid IN (SELECT ctid FROM "RateLimitCounter" WHERE "expiresAt" < ${now.toISOString()}::timestamp LIMIT ${batch})`;
  return deleted;
}

export function rateLimited(): AppError {
  return new AppError(429, "RATE_LIMITED", "請求過於頻繁，請稍後再試");
}
