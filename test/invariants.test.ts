import { createCipheriv, createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CREDIT_FLOOR } from "../src/config/credit.js";
import { prisma } from "../src/lib/prisma.js";
import { attendeeService } from "../src/services/attendee.service.js";
import { billingService } from "../src/services/billing.service.js";
import { importService } from "../src/services/import.service.js";
import { HEADER, balanceOf, createEvent, createOwner, people, previewOf, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
});

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

// 帳務不變條件（不依賴某一把鎖，只驗證最終結果）：
// 1. 餘額 = 起始餘額 + 帳本加總（每一筆變動都有紀錄，沒有漏記或重複）
// 2. 扣掉的點數 = 實際建立的計費人數加總（沒有只扣點沒名單、或有名單沒扣點）
// 3. 沒有任何一個時間點讓餘額低於下限（以最終與歷程中的 balanceAfter 驗證）
async function assertInvariants(userId: string, startBalance: number, eventIds: string[]) {
  const ledger = await prisma.creditTransaction.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  const sum = ledger.reduce((s, t) => s + t.amount, 0);
  expect(await balanceOf(userId)).toBe(startBalance + sum);

  const debits = ledger.filter((t) => t.reason === "ATTENDEE_CREATE" || t.reason === "ATTENDEE_IMPORT").reduce((s, t) => s - t.amount, 0);
  const agg = await prisma.attendee.aggregate({ where: { eventId: { in: eventIds } }, _sum: { checkInCapacity: true } });
  expect(agg._sum.checkInCapacity ?? 0).toBe(debits);

  // 逐筆驗證：帳本記錄的餘額都不低於下限（儲值入帳後才可能高於 0）
  for (const t of ledger) expect(t.balanceAfter).toBeGreaterThanOrEqual(CREDIT_FLOOR);
}

describe("最終帳務不變條件（混合並行操作）", () => {
  it("新增、匯入、調高人數、付款（含重複通知）、取消預覽同時發生後，帳務仍然一致", async () => {
    const owner = await createOwner(0);
    const e1 = await createEvent(owner.id);
    const e2 = await createEvent(owner.id);

    // 階段 1：餘額 0，8 個同時新增 → 只有 3 個成功（-3），其餘被擋
    const first = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => attendeeService.createSingle(e1.id, owner.id, { name: `a${i}`, phone: `0911${i}`, capacity: 1 }))
    );
    expect(first.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    await assertInvariants(owner.id, 0, [e1.id, e2.id]);

    // 階段 2：付款成功，且同一通知被並行送兩次 → 只入帳一次
    const checkout = await billingService.createCheckoutSession(owner.id, "SMALL");
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: checkout.paymentId } });
    const body = signedNotify(payment.providerOrderNo!, 590, "T-INV-1");
    await Promise.allSettled([billingService.handleNewebPayNotify(body), billingService.handleNewebPayNotify(body)]);
    expect(await balanceOf(owner.id)).toBe(-3 + 199);

    // 階段 3：同時進行 — 兩場活動各自新增、調高人數、兩份匯入（同一份名單確認兩次）、一份預覽被取消
    const imp = await previewOf(e2.id, owner.id, [HEADER, ...people(20, "I")]);
    const discarded = await previewOf(e2.id, owner.id, [HEADER, ...people(5, "D")]);
    const target = await prisma.attendee.findFirstOrThrow({ where: { eventId: e1.id } });
    const second = await Promise.allSettled([
      ...Array.from({ length: 4 }, (_, i) => attendeeService.createSingle(e1.id, owner.id, { name: `b${i}`, phone: `0922${i}`, capacity: 2 })),
      attendeeService.update(e1.id, target.id, { checkInCapacity: target.checkInCapacity + 3 }),
      importService.confirm(e2.id, owner.id, imp.sessionId, { expectedCost: 20 }),
      importService.confirm(e2.id, owner.id, imp.sessionId, { expectedCost: 20 }),
      importService.discard(e2.id, owner.id, discarded.sessionId)
    ]);
    expect(second.some((r) => r.status === "fulfilled")).toBe(true);
    await assertInvariants(owner.id, 0, [e1.id, e2.id]);

    // 匯入只會發生一次
    expect(await prisma.attendee.count({ where: { eventId: e2.id } })).toBe(20);
    expect(await prisma.creditTransaction.count({ where: { userId: owner.id, reason: "ATTENDEE_IMPORT" } })).toBe(1);
    // 被取消的預覽沒有留下任何東西
    expect(await prisma.importSession.count({ where: { id: discarded.sessionId } })).toBe(0);
    // 付款只入帳一次
    expect(await prisma.creditTransaction.count({ where: { userId: owner.id, reason: "PAYMENT_TOPUP" } })).toBe(1);
  });

  it("失敗的操作（點數不足、過期、他人）不會留下任何扣點或名單", async () => {
    const owner = await createOwner(0);
    const other = await createOwner(50);
    const event = await createEvent(owner.id);
    const big = await previewOf(event.id, owner.id, [HEADER, ...people(50, "B")]);

    await expect(importService.confirm(event.id, owner.id, big.sessionId, { expectedCost: 50 })).rejects.toMatchObject({ statusCode: 402 });
    await expect(importService.confirm(event.id, other.id, big.sessionId, { expectedCost: 50 })).rejects.toBeTruthy();
    await prisma.importSession.update({ where: { id: big.sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(importService.confirm(event.id, owner.id, big.sessionId, { expectedCost: 50 })).rejects.toMatchObject({ statusCode: 410 });

    await assertInvariants(owner.id, 0, [event.id]);
    expect(await prisma.creditTransaction.count({ where: { userId: { in: [owner.id, other.id] } } })).toBe(0);
    expect(await balanceOf(other.id)).toBe(50);
  });
});
