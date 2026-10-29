import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createCipheriv, createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { billingService } from "../src/services/billing.service.js";
import { importService } from "../src/services/import.service.js";
import { maintenanceService } from "../src/services/maintenance.service.js";
import { HEADER, balanceOf, createEvent, createOwner, people, previewOf, resetDb } from "./helpers.js";

let server: Server;
let base = "";

beforeAll(async () => {
  const { app } = await import("../src/app.js");
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});
beforeEach(async () => {
  await resetDb();
  await prisma.maintenanceRun.deleteMany();
});
afterEach(() => {
  delete process.env.CRON_SECRET;
});

const cron = async (authorization?: string) => {
  const res = await fetch(`${base}/internal/cron/maintenance`, { headers: authorization ? { authorization } : {} });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
};

async function expiredSession(eventId: string, userId: string, status: "PREVIEW" | "CONFIRMED" = "PREVIEW", ago = 1000) {
  return prisma.importSession.create({
    data: { eventId, userId, fileName: "x.xlsx", fileHash: "h", rows: [], rowErrors: [], status, expiresAt: new Date(Date.now() - ago) }
  });
}

describe("排程端點：必須有正確的 CRON_SECRET", () => {
  it("沒有設定 CRON_SECRET：拒絕，即使帶了 Bearer", async () => {
    expect((await cron()).status).toBe(401);
    expect((await cron("Bearer ")).status).toBe(401);
    expect((await cron("Bearer anything")).status).toBe(401);
    expect(await prisma.maintenanceRun.count()).toBe(0);
  });

  it("有設定但沒帶或不符：拒絕且不執行、不留下執行紀錄", async () => {
    process.env.CRON_SECRET = "s3cret-value-for-test";
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    const stale = await expiredSession(event.id, owner.id);
    expect((await cron()).status).toBe(401);
    expect((await cron("Bearer wrong")).status).toBe(401);
    expect((await cron("s3cret-value-for-test")).status).toBe(401); // 少了 Bearer
    expect(await prisma.importSession.count({ where: { id: stale.id } })).toBe(1);
    expect(await prisma.maintenanceRun.count()).toBe(0);
  });

  it("密鑰正確：執行並回傳摘要；回應與紀錄都不含密鑰", async () => {
    process.env.CRON_SECRET = "s3cret-value-for-test";
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    await expiredSession(event.id, owner.id);
    const res = await cron("Bearer s3cret-value-for-test");
    expect(res.status).toBe(200);
    expect(res.json.data).toMatchObject({ importSessionsDeleted: 1, moreRemaining: false });
    expect(res.text).not.toContain("s3cret-value-for-test");
    const run = await prisma.maintenanceRun.findFirstOrThrow();
    expect(run.ok).toBe(true);
    expect(JSON.stringify(run)).not.toContain("s3cret-value-for-test");
  });
});

describe("清理：只清過期的預覽，可分批、可重跑、不碰處理中的資料", () => {
  it("只刪「已過期的預覽」：未過期的預覽、已確認的歷史摘要都保留；過期的計數也一併清掉", async () => {
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    const expired = await expiredSession(event.id, owner.id, "PREVIEW");
    const confirmedOld = await expiredSession(event.id, owner.id, "CONFIRMED", 90 * 24 * 3600_000);
    const live = await prisma.importSession.create({
      data: { eventId: event.id, userId: owner.id, fileName: "y", fileHash: "h", rows: [], rowErrors: [], expiresAt: new Date(Date.now() + 3600_000) }
    });
    await prisma.rateLimitCounter.createMany({
      data: [
        { key: "old", windowStart: new Date(Date.now() - 7200_000), count: 1, expiresAt: new Date(Date.now() - 3600_000) },
        { key: "live", windowStart: new Date(), count: 1, expiresAt: new Date(Date.now() + 60_000) }
      ]
    });

    const result = await maintenanceService.purgeExpired();
    expect(result).toMatchObject({ importSessionsDeleted: 1, rateLimitCountersDeleted: 1 });
    expect(await prisma.importSession.count({ where: { id: expired.id } })).toBe(0);
    expect(await prisma.importSession.count({ where: { id: { in: [confirmedOld.id, live.id] } } })).toBe(2);
    expect(await prisma.rateLimitCounter.count({ where: { key: "live" } })).toBe(1);
  });

  it("分批：每批有上限，剩下的標示 moreRemaining，下次接著清；全部清完後再跑不會有任何動作", async () => {
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    for (let i = 0; i < 5; i++) await expiredSession(event.id, owner.id);

    const first = await maintenanceService.purgeExpired({ batchSize: 2, maxBatches: 1 });
    expect(first).toMatchObject({ importSessionsDeleted: 2, moreRemaining: true });
    const second = await maintenanceService.purgeExpired({ batchSize: 2, maxBatches: 10 });
    expect(second).toMatchObject({ importSessionsDeleted: 3, moreRemaining: false });
    const third = await maintenanceService.purgeExpired();
    expect(third).toMatchObject({ importSessionsDeleted: 0, moreRemaining: false });
    expect(await prisma.importSession.count()).toBe(0);
    expect(await prisma.maintenanceRun.count({ where: { ok: true } })).toBe(3);
  });

  it("正在被確認（持有資料列鎖）的預覽會被跳過，不會卡住也不會被刪；鎖釋放後下次清掉", async () => {
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    const busy = await expiredSession(event.id, owner.id);

    let duringLock: Awaited<ReturnType<typeof maintenanceService.purgeExpired>> | null = null;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ImportSession" WHERE id = ${busy.id} FOR UPDATE`;
      duringLock = await maintenanceService.purgeExpired();
    });
    expect(duringLock).toMatchObject({ importSessionsDeleted: 0 });
    expect(await prisma.importSession.count({ where: { id: busy.id } })).toBe(1);

    expect(await maintenanceService.purgeExpired()).toMatchObject({ importSessionsDeleted: 1 });
  });

  it("維護紀錄只保留 90 天", async () => {
    await prisma.maintenanceRun.create({ data: { job: "purge-expired", startedAt: new Date(Date.now() - 100 * 24 * 3600_000), ok: true } });
    const result = await maintenanceService.purgeExpired();
    expect(result.oldRunsDeleted).toBe(1);
  });
});

describe("過期但尚未被清掉的預覽：不能讀、不能改、不能確認", () => {
  it("回 410，沒有新增名單、沒有扣點", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(3)]);
    await prisma.importSession.update({ where: { id: preview.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expect(importService.getPreview(event.id, owner.id, preview.sessionId)).rejects.toMatchObject({ statusCode: 410 });
    await expect(importService.setDecisions(event.id, owner.id, preview.sessionId, { bulk: "ALL_NEW" })).rejects.toMatchObject({ statusCode: 410 });
    await expect(importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 3 })).rejects.toMatchObject({ statusCode: 410 });
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(0);
    expect(await balanceOf(owner.id)).toBe(100);
  });
});

describe("付款期間延長暫存：有上限、只延長自己且未過期的預覽", () => {
  const url = (eventId: string, sessionId: string) => `/admin/events/${eventId}?importSession=${sessionId}`;

  it("延長到現在起約 2 小時，但從建立起算最長 48 小時，反覆付款也無法超過", async () => {
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(2)]);
    const created = (await prisma.importSession.findUniqueOrThrow({ where: { id: preview.sessionId } })).createdAt.getTime();

    // 模擬快到期：剩 10 分鐘
    await prisma.importSession.update({ where: { id: preview.sessionId }, data: { expiresAt: new Date(Date.now() + 600_000) } });
    const extended = await importService.extendForPayment(owner.id, url(event.id, preview.sessionId));
    expect(extended!.getTime()).toBeGreaterThan(Date.now() + 100 * 60_000);
    expect(extended!.getTime()).toBeLessThanOrEqual(Date.now() + 121 * 60_000);

    // 把建立時間拉到 47 小時前：再延長也只能到建立後 48 小時
    await prisma.importSession.update({ where: { id: preview.sessionId }, data: { createdAt: new Date(Date.now() - 47 * 3600_000), expiresAt: new Date(Date.now() + 600_000) } });
    for (let i = 0; i < 3; i++) await importService.extendForPayment(owner.id, url(event.id, preview.sessionId));
    const row = await prisma.importSession.findUniqueOrThrow({ where: { id: preview.sessionId } });
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(row.createdAt.getTime() + 48 * 3600_000);
    expect(created).toBeLessThan(Date.now());
  });

  it("他人的、已過期的、已確認的預覽都不會被延長或復活", async () => {
    const owner = await createOwner(0);
    const other = await createOwner(0);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(2)]);
    const before = (await prisma.importSession.findUniqueOrThrow({ where: { id: preview.sessionId } })).expiresAt;

    expect(await importService.extendForPayment(other.id, url(event.id, preview.sessionId))).toBeNull();
    expect((await prisma.importSession.findUniqueOrThrow({ where: { id: preview.sessionId } })).expiresAt).toEqual(before);

    const stale = await expiredSession(event.id, owner.id);
    expect(await importService.extendForPayment(owner.id, url(event.id, stale.id))).toBeNull();
    expect((await prisma.importSession.findUniqueOrThrow({ where: { id: stale.id } })).expiresAt.getTime()).toBeLessThan(Date.now());

    const done = await expiredSession(event.id, owner.id, "CONFIRMED");
    expect(await importService.extendForPayment(owner.id, url(event.id, done.id))).toBeNull();
  });

  it("建立付款時會帶動延長；返回網址格式不對則忽略", async () => {
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(2)]);
    await prisma.importSession.update({ where: { id: preview.sessionId }, data: { expiresAt: new Date(Date.now() + 300_000) } });
    await billingService.createCheckoutSession(owner.id, "SMALL", url(event.id, preview.sessionId));
    const row = await prisma.importSession.findUniqueOrThrow({ where: { id: preview.sessionId } });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 100 * 60_000);

    expect(await importService.extendForPayment(owner.id, "/admin/billing")).toBeNull();
    expect(await importService.extendForPayment(owner.id, null)).toBeNull();
  });
});

describe("付款入帳不依賴匯入暫存", () => {
  const KEY = process.env.NEWEBPAY_HASH_KEY!;
  const IV = process.env.NEWEBPAY_HASH_IV!;
  const MERCHANT = process.env.NEWEBPAY_MERCHANT_ID!;
  function signedNotify(orderNo: string, amount: number, tradeNo: string) {
    const payload = JSON.stringify({
      Status: "SUCCESS",
      Result: { MerchantID: MERCHANT, Amt: amount, TradeNo: tradeNo, MerchantOrderNo: orderNo, PayTime: "2026-10-29 14:00:00" }
    });
    const cipher = createCipheriv("aes-256-cbc", KEY, IV);
    const tradeInfo = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]).toString("hex");
    const tradeSha = createHash("sha256").update(`HashKey=${KEY}&${tradeInfo}&HashIV=${IV}`).digest("hex").toUpperCase();
    return { TradeInfo: tradeInfo, TradeSha: tradeSha };
  }

  it("預覽在付款期間過期甚至被清掉：點數照樣加，使用者看到的是『請重新上傳』", async () => {
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(2)]);
    const checkout = await billingService.createCheckoutSession(owner.id, "SMALL", `/admin/events/${event.id}?importSession=${preview.sessionId}`);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } });

    await prisma.importSession.delete({ where: { id: preview.sessionId } }); // 模擬暫存已被清掉
    await billingService.handleNewebPayNotify(signedNotify(payment.providerOrderNo!, 590, "T-EXPIRED-1"));

    expect(await balanceOf(owner.id)).toBe(199);
    await expect(importService.getPreview(event.id, owner.id, preview.sessionId)).rejects.toMatchObject({
      statusCode: 404,
      code: "IMPORT_SESSION_NOT_FOUND"
    });
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(0);
  });
});
