import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import { PaymentProduct, PaymentStatus } from "@prisma/client";
import { env } from "../config/env.js";
import { AppError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";

const provider = "newebpay";

export const pricingTiers = [
  {
    id: "SMALL",
    label: "小型活動",
    attendeeRange: "1-199 人",
    attendeeCredits: 199,
    amount: 590,
    currency: "TWD" as const
  },
  {
    id: "MEDIUM",
    label: "標準活動",
    attendeeRange: "200-599 人",
    attendeeCredits: 599,
    amount: 790,
    currency: "TWD" as const
  },
  {
    id: "LARGE",
    label: "大型活動",
    attendeeRange: "600-999 人",
    attendeeCredits: 999,
    amount: 990,
    currency: "TWD" as const
  }
] as const;

function getPricingTier(tierId: string) {
  const tier = pricingTiers.find((item) => item.id === tierId);
  if (!tier) throw new AppError(400, "INVALID_PRICING_TIER", "不支援的方案");
  return tier;
}

function requireNewebPayConfig() {
  if (!env.NEWEBPAY_MERCHANT_ID || !env.NEWEBPAY_HASH_KEY || !env.NEWEBPAY_HASH_IV) {
    throw new AppError(500, "BILLING_NOT_CONFIGURED", "藍新金流環境變數尚未設定");
  }
  if (
    Buffer.byteLength(env.NEWEBPAY_HASH_KEY) !== 32 ||
    Buffer.byteLength(env.NEWEBPAY_HASH_IV) !== 16
  ) {
    throw new AppError(500, "BILLING_KEY_INVALID", "藍新 HashKey 需 32 字元，HashIV 需 16 字元");
  }
  return {
    merchantId: env.NEWEBPAY_MERCHANT_ID,
    hashKey: env.NEWEBPAY_HASH_KEY,
    hashIv: env.NEWEBPAY_HASH_IV,
    apiUrl: env.NEWEBPAY_API_URL,
    version: env.NEWEBPAY_VERSION
  };
}

function appUrl(base: string, path: string) {
  return `${base.replace(/\/$/, "")}${path}`;
}

function encryptTradeInfo(params: Record<string, string>, key: string, iv: string) {
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    cipher.update(new URLSearchParams(params).toString(), "utf8"),
    cipher.final()
  ]).toString("hex");
}

function decryptTradeInfo(tradeInfo: string, key: string, iv: string) {
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const decoded = Buffer.concat([
    decipher.update(Buffer.from(tradeInfo, "hex")),
    decipher.final()
  ]).toString("utf8");
  try {
    return JSON.parse(decoded) as NewebPayResult;
  } catch {
    return Object.fromEntries(new URLSearchParams(decoded).entries()) as NewebPayResult;
  }
}

function createTradeSha(tradeInfo: string, key: string, iv: string) {
  return createHash("sha256")
    .update(`HashKey=${key}&${tradeInfo}&HashIV=${iv}`)
    .digest("hex")
    .toUpperCase();
}

function createMerchantOrderNo() {
  return `MM${Date.now()}${randomBytes(3).toString("hex").toUpperCase()}`;
}

function parseNewebPayDate(value: unknown) {
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(`${value.replace(" ", "T")}+08:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function getBodyValue(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

type NewebPayResult = {
  Status?: string;
  Result?: { MerchantID?: string; Amt?: number | string; TradeNo?: string; MerchantOrderNo?: string; PayTime?: string };
  MerchantID?: string;
  Amt?: number | string;
  TradeNo?: string;
  MerchantOrderNo?: string;
  PayTime?: string;
};

function getResult(decoded: NewebPayResult) {
  return decoded.Result ?? decoded;
}

async function applyPaidPayment(decoded: NewebPayResult) {
  const result = getResult(decoded);
  if (!result.MerchantOrderNo) throw new AppError(400, "PAYMENT_ORDER_MISSING", "缺少商店訂單編號");

  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { providerOrderNo: result.MerchantOrderNo } });
    if (!payment) throw new AppError(404, "PAYMENT_NOT_FOUND", "找不到付款紀錄");

    if (payment.amountTotal !== Number(result.Amt ?? 0)) {
      throw new AppError(400, "PAYMENT_AMOUNT_MISMATCH", "付款金額不一致");
    }
    if (payment.status === PaymentStatus.PAID && payment.creditsGranted > 0) {
      return { credited: false, paymentId: payment.id };
    }

    const toGrant = payment.creditsGranted > 0 ? 0 : (payment.attendeeLimit ?? 0);
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.PAID,
        creditsGranted: payment.creditsGranted + toGrant,
        providerTradeNo: result.TradeNo,
        paidAt: parseNewebPayDate(result.PayTime) ?? new Date()
      }
    });
    if (toGrant > 0) {
      await tx.user.update({
        where: { id: payment.userId },
        data: { attendeeCredits: { increment: toGrant } }
      });
    }
    return { credited: toGrant > 0, paymentId: payment.id };
  });
}

export const billingService = {
  listPricingTiers() {
    return pricingTiers;
  },

  async getStatus(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { attendeeCredits: true, payments: { orderBy: { createdAt: "desc" }, take: 8 } }
    });
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "找不到使用者");
    return {
      attendeeCredits: user.attendeeCredits,
      recentPayments: user.payments.map((p) => ({
        id: p.id, status: p.status, product: p.product, quantity: p.quantity,
        creditsGranted: p.creditsGranted, amountTotal: p.amountTotal, currency: p.currency,
        pricingTier: p.pricingTier, attendeeLimit: p.attendeeLimit,
        providerOrderNo: p.providerOrderNo, providerTradeNo: p.providerTradeNo,
        consumedAt: p.consumedAt?.toISOString() ?? null,
        paidAt: p.paidAt?.toISOString() ?? null,
        createdAt: p.createdAt.toISOString()
      }))
    };
  },

  async createCheckoutSession(userId: string, tierId: string) {
    const config = requireNewebPayConfig();
    const tier = getPricingTier(tierId);
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "找不到使用者");

    const merchantOrderNo = createMerchantOrderNo();
    const payment = await prisma.payment.create({
      data: {
        userId,
        provider,
        product: PaymentProduct.ATTENDEE_CREDIT,
        status: PaymentStatus.PENDING,
        amountTotal: tier.amount,
        currency: tier.currency,
        pricingTier: tier.id,
        attendeeLimit: tier.attendeeCredits,
        providerOrderNo: merchantOrderNo,
        checkoutUrl: config.apiUrl
      }
    });

    const tradeInfo = encryptTradeInfo(
      {
        MerchantID: config.merchantId,
        RespondType: "JSON",
        TimeStamp: String(Math.floor(Date.now() / 1000)),
        Version: config.version,
        MerchantOrderNo: merchantOrderNo,
        Amt: String(tier.amount),
        ItemDesc: `MonMate ${tier.label} ${tier.attendeeCredits} 人報到額度`,
        ReturnURL: appUrl(env.API_BASE_URL, "/billing/newebpay/return"),
        NotifyURL: appUrl(env.API_BASE_URL, "/billing/newebpay/notify"),
        ClientBackURL: appUrl(env.WEB_APP_URL, "/admin/billing"),
        LoginType: "0", CREDIT: "1", WEBATM: "0", VACC: "0", CVS: "0", BARCODE: "0"
      },
      config.hashKey, config.hashIv
    );

    return {
      paymentId: payment.id,
      action: config.apiUrl,
      method: "POST" as const,
      fields: {
        MerchantID: config.merchantId,
        TradeInfo: tradeInfo,
        TradeSha: createTradeSha(tradeInfo, config.hashKey, config.hashIv),
        Version: config.version
      }
    };
  },

  async handleNewebPayNotify(body: Record<string, unknown>) {
    const config = requireNewebPayConfig();
    const tradeInfo = getBodyValue(body, "TradeInfo");
    const tradeSha = getBodyValue(body, "TradeSha");
    if (!tradeInfo || !tradeSha) throw new AppError(400, "NEWEBPAY_PAYLOAD_INVALID", "藍新回傳資料不完整");

    if (tradeSha.toUpperCase() !== createTradeSha(tradeInfo, config.hashKey, config.hashIv)) {
      throw new AppError(400, "NEWEBPAY_SIGNATURE_INVALID", "藍新簽章不一致");
    }

    const decoded = decryptTradeInfo(tradeInfo, config.hashKey, config.hashIv);
    const result = getResult(decoded);
    if (result.MerchantID && result.MerchantID !== config.merchantId) {
      throw new AppError(400, "NEWEBPAY_MERCHANT_INVALID", "商店代號不一致");
    }

    if (decoded.Status === "SUCCESS") {
      return { received: true, status: decoded.Status, ...(await applyPaidPayment(decoded)) };
    }

    if (result.MerchantOrderNo) {
      await prisma.payment.updateMany({
        where: { providerOrderNo: result.MerchantOrderNo, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.FAILED }
      });
    }
    return { received: true, status: decoded.Status ?? "FAILED" };
  },

  async getNewebPayReturnUrl(body: Record<string, unknown>) {
    try {
      const result = await this.handleNewebPayNotify(body);
      const status = "paymentId" in result && result.paymentId ? "success" : "pending";
      return appUrl(env.WEB_APP_URL, `/admin/billing?payment=${status}`);
    } catch {
      return appUrl(env.WEB_APP_URL, "/admin/billing?payment=failed");
    }
  }
};
