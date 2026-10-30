import { createCipheriv, createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { billingService } from "../src/services/billing.service.js";
import { importService } from "../src/services/import.service.js";
import { HEADER, balanceOf, createEvent, createOwner, people, previewOf, resetDb } from "./helpers.js";

const KEY = process.env.NEWEBPAY_HASH_KEY!;
const IV = process.env.NEWEBPAY_HASH_IV!;
const MERCHANT = process.env.NEWEBPAY_MERCHANT_ID!;

// 以和藍新相同的方式自行簽出測試通知（AES-256-CBC + SHA256），再交給真正的驗簽與入帳邏輯處理
function signedNotify(orderNo: string, amount: number, tradeNo: string, status = "SUCCESS") {
  const payload = JSON.stringify({
    Status: status,
    Result: { MerchantID: MERCHANT, Amt: amount, TradeNo: tradeNo, MerchantOrderNo: orderNo, PayTime: "2026-10-29 14:00:00" }
  });
  const cipher = createCipheriv("aes-256-cbc", KEY, IV);
  const tradeInfo = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]).toString("hex");
  const tradeSha = createHash("sha256").update(`HashKey=${KEY}&${tradeInfo}&HashIV=${IV}`).digest("hex").toUpperCase();
  return { TradeInfo: tradeInfo, TradeSha: tradeSha };
}

async function startCheckout(userId: string, tierId = "SMALL", returnTo?: string) {
  const session = await billingService.createCheckoutSession(userId, tierId, returnTo);
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: session.paymentId } });
  return { session, payment };
}

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
});

describe("付款入帳", () => {
  it("驗簽成功才加點；同一通知重複送達不重複加點", async () => {
    const owner = await createOwner(0);
    const { payment } = await startCheckout(owner.id);
    const body = signedNotify(payment.providerOrderNo!, 590, "T0001");

    await billingService.handleNewebPayNotify(body);
    await billingService.handleNewebPayNotify(body);
    await billingService.handleNewebPayNotify(body);

    expect(await balanceOf(owner.id)).toBe(199);
    expect(await prisma.creditTransaction.count({ where: { userId: owner.id, reason: "PAYMENT_TOPUP" } })).toBe(1);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("PAID");
  });

  it("notify 與 return 同時送達（並行重複通知）：只加一次", async () => {
    const owner = await createOwner(0);
    const { payment } = await startCheckout(owner.id);
    const body = signedNotify(payment.providerOrderNo!, 590, "T0002");
    // 20 個同時到達（notify 與 return 混合），提高兩邊同時判斷「尚未入帳」的機會
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        i % 4 === 0 ? billingService.getNewebPayReturnUrl(body) : billingService.handleNewebPayNotify(body)
      )
    );
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await balanceOf(owner.id)).toBe(199);
    expect(await prisma.creditTransaction.count({ where: { userId: owner.id, reason: "PAYMENT_TOPUP" } })).toBe(1);
  });

  it("簽章不符或金額不符：拒絕、不加點", async () => {
    const owner = await createOwner(0);
    const { payment } = await startCheckout(owner.id);
    const good = signedNotify(payment.providerOrderNo!, 590, "T0003");
    await expect(
      billingService.handleNewebPayNotify({ ...good, TradeSha: "0".repeat(64) })
    ).rejects.toMatchObject({ code: "NEWEBPAY_SIGNATURE_INVALID" });
    await expect(
      billingService.handleNewebPayNotify(signedNotify(payment.providerOrderNo!, 1, "T0004"))
    ).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });
    expect(await balanceOf(owner.id)).toBe(0);
  });

  it("付款失敗：標為 FAILED、不加點；之後補到成功通知仍可入帳（通知延遲可恢復）", async () => {
    const owner = await createOwner(0);
    const { payment } = await startCheckout(owner.id);
    await billingService.handleNewebPayNotify(signedNotify(payment.providerOrderNo!, 590, "", "FAILED"));
    expect((await billingService.getPayment(owner.id, payment.id)).status).toBe("FAILED");
    expect(await balanceOf(owner.id)).toBe(0);

    await billingService.handleNewebPayNotify(signedNotify(payment.providerOrderNo!, 590, "T0005"));
    expect(await balanceOf(owner.id)).toBe(199);
  });
});

describe("付款狀態與返回", () => {
  it("確認中、逾時與已完成的狀態", async () => {
    const owner = await createOwner(0);
    const { payment } = await startCheckout(owner.id);
    expect(await billingService.getPayment(owner.id, payment.id)).toMatchObject({ status: "PENDING", stale: false });

    await prisma.payment.update({ where: { id: payment.id }, data: { createdAt: new Date(Date.now() - 2 * 3600 * 1000) } });
    expect(await billingService.getPayment(owner.id, payment.id)).toMatchObject({ status: "PENDING", stale: true });

    await billingService.handleNewebPayNotify(signedNotify(payment.providerOrderNo!, 590, "T0006"));
    expect(await billingService.getPayment(owner.id, payment.id)).toMatchObject({ status: "PAID", stale: false, balance: 199 });
  });

  it("他人不能查詢你的付款", async () => {
    const owner = await createOwner(0);
    const other = await createOwner(0);
    const { payment } = await startCheckout(owner.id);
    await expect(billingService.getPayment(other.id, payment.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("returnTo 只接受站內後台路徑，並在返回網址帶回付款編號", async () => {
    const owner = await createOwner(0);
    await expect(startCheckout(owner.id, "SMALL", "https://evil.example/x")).rejects.toMatchObject({ code: "INVALID_RETURN_TO" });
    await expect(startCheckout(owner.id, "SMALL", "//evil.example")).rejects.toMatchObject({ code: "INVALID_RETURN_TO" });

    const returnTo = "/admin/events/evt_1?importSession=sess_1";
    const { payment } = await startCheckout(owner.id, "SMALL", returnTo);
    const url = new URL(await billingService.getNewebPayReturnUrl(signedNotify(payment.providerOrderNo!, 590, "T0007")));
    expect(url.pathname).toBe("/admin/events/evt_1");
    expect(url.searchParams.get("importSession")).toBe("sess_1");
    expect(url.searchParams.get("payment")).toBe("success");
    expect(url.searchParams.get("paymentId")).toBe(payment.id);
  });
});

describe("付款後接續匯入", () => {
  it("點數不足 → 付款 → 回到同一份預覽確認：只新增一次、只扣一次", async () => {
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(100)]);
    await expect(
      importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 100 })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ATTENDEE_CREDITS" });

    const { payment } = await startCheckout(owner.id, "SMALL", `/admin/events/${event.id}?importSession=${preview.sessionId}`);
    const body = signedNotify(payment.providerOrderNo!, 590, "T0008");
    await billingService.handleNewebPayNotify(body);
    await billingService.handleNewebPayNotify(body); // 重複通知

    // 回到原操作：重新取得預覽（依最新餘額重算），再由使用者確認
    const back = await importService.getPreview(event.id, owner.id, preview.sessionId);
    expect(back.status).toBe("PREVIEW");
    if (back.status === "PREVIEW") expect(back.preview.wallet).toMatchObject({ balance: 199, balanceAfter: 99, needsTopUp: false });
    await importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 100 });
    await importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: 100 }); // 重新整理後再按一次

    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(100);
    expect(await balanceOf(owner.id)).toBe(99);
    expect(await prisma.creditTransaction.count({ where: { userId: owner.id, reason: "ATTENDEE_IMPORT" } })).toBe(1);
  });
});

describe("購買前同意退款條款的留存", () => {
  it("勾選同意：記錄同意時間與條款版本", async () => {
    const owner = await createOwner(0);
    const before = Date.now();
    const session = await billingService.createCheckoutSession(owner.id, "SMALL", undefined, { version: "2026-10-30" });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: session.paymentId } });
    expect(payment.termsVersion).toBe("2026-10-30");
    expect(payment.termsAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("沒有同意資料（舊版前端）：照常建立付款，同意欄位為空", async () => {
    const owner = await createOwner(0);
    const session = await billingService.createCheckoutSession(owner.id, "SMALL");
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: session.paymentId } });
    expect(payment.termsAcceptedAt).toBeNull();
    expect(payment.termsVersion).toBeNull();
  });

  it("同意但沒帶版本：仍記錄同意時間，版本為空", async () => {
    const owner = await createOwner(0);
    const session = await billingService.createCheckoutSession(owner.id, "SMALL", undefined, { version: null });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: session.paymentId } });
    expect(payment.termsAcceptedAt).not.toBeNull();
    expect(payment.termsVersion).toBeNull();
  });
});
