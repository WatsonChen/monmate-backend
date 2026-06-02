import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import { PaymentProduct, PaymentStatus } from "@prisma/client";
import { env } from "../config/env";
import { AppError } from "../lib/http";
import { prisma } from "../lib/prisma";

const provider = "newebpay";
const eventCreditQuantity = 1;

export const pricingTiers = [
  {
    id: "SMALL",
    label: "小型活動",
    attendeeRange: "1-199 人",
    attendeeLimit: 199,
    amount: 590,
    currency: "TWD" as const
  },
  {
    id: "MEDIUM",
    label: "標準活動",
    attendeeRange: "200-599 人",
    attendeeLimit: 599,
    amount: 790,
    currency: "TWD" as const
  },
  {
    id: "LARGE",
    label: "大型活動",
    attendeeRange: "600-999 人",
    attendeeLimit: 999,
    amount: 990,
    currency: "TWD" as const
  }
] as const;

function getPricingTier(tierId: string) {
  const tier = pricingTiers.find((item) => item.id === tierId);

  if (!tier) {
    throw new AppError(400, "INVALID_PRICING_TIER", "不支援的活動人數方案");
  }

  return tier;
}

function requireNewebPayConfig() {
  if (
    !env.NEWEBPAY_MERCHANT_ID ||
    !env.NEWEBPAY_HASH_KEY ||
    !env.NEWEBPAY_HASH_IV
  ) {
    throw new AppError(
      500,
      "BILLING_NOT_CONFIGURED",
      "藍新金流環境變數尚未設定"
    );
  }

  if (
    Buffer.byteLength(env.NEWEBPAY_HASH_KEY) !== 32 ||
    Buffer.byteLength(env.NEWEBPAY_HASH_IV) !== 16
  ) {
    throw new AppError(
      500,
      "BILLING_KEY_INVALID",
      "藍新 HashKey 需為 32 字元，HashIV 需為 16 字元"
    );
  }

  return {
    merchantId: env.NEWEBPAY_MERCHANT_ID,
    hashKey: env.NEWEBPAY_HASH_KEY,
    hashIv: env.NEWEBPAY_HASH_IV,
    apiUrl: env.NEWEBPAY_API_URL,
    version: env.NEWEBPAY_VERSION
  };
}

function appUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function encryptTradeInfo(params: Record<string, string>, key: string, iv: string) {
  const plainText = new URLSearchParams(params).toString();
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]).toString(
    "hex"
  );
}

function decryptTradeInfo(tradeInfo: string, key: string, iv: string) {
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  const decoded = Buffer.concat([
    decipher.update(Buffer.from(tradeInfo, "hex")),
    decipher.final()
  ]).toString("utf8");

  try {
    return JSON.parse(decoded) as NewebPayDecodedTradeInfo;
  } catch {
    const params = new URLSearchParams(decoded);
    return Object.fromEntries(params.entries()) as NewebPayDecodedTradeInfo;
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
  if (typeof value !== "string" || !value) {
    return undefined;
  }

  const normalized = value.replace(" ", "T");
  const date = new Date(`${normalized}+08:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function getBodyValue(body: Record<string, unknown>, key: string) {
  const value = body[key];
  if (Array.isArray(value)) {
    return value[0];
  }

  return typeof value === "string" ? value : undefined;
}

function toPaymentDTO(payment: {
  id: string;
  status: PaymentStatus;
  product: PaymentProduct;
  quantity: number;
  creditsGranted: number;
  amountTotal: number | null;
  currency: string | null;
  pricingTier: string | null;
  attendeeLimit: number | null;
  providerOrderNo: string | null;
  providerTradeNo: string | null;
  consumedAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: payment.id,
    status: payment.status,
    product: payment.product,
    quantity: payment.quantity,
    creditsGranted: payment.creditsGranted,
    amountTotal: payment.amountTotal,
    currency: payment.currency,
    pricingTier: payment.pricingTier,
    attendeeLimit: payment.attendeeLimit,
    providerOrderNo: payment.providerOrderNo,
    providerTradeNo: payment.providerTradeNo,
    consumedAt: payment.consumedAt?.toISOString() ?? null,
    paidAt: payment.paidAt?.toISOString() ?? null,
    createdAt: payment.createdAt.toISOString()
  };
}

type NewebPayDecodedTradeInfo = {
  Status?: string;
  Message?: string;
  Result?: {
    MerchantID?: string;
    Amt?: number | string;
    TradeNo?: string;
    MerchantOrderNo?: string;
    PaymentType?: string;
    PayTime?: string;
  };
  MerchantID?: string;
  Amt?: number | string;
  TradeNo?: string;
  MerchantOrderNo?: string;
  PaymentType?: string;
  PayTime?: string;
};

function getNewebPayResult(decoded: NewebPayDecodedTradeInfo) {
  return decoded.Result ?? decoded;
}

async function applyPaidPayment(decoded: NewebPayDecodedTradeInfo) {
  const result = getNewebPayResult(decoded);
  const merchantOrderNo = result.MerchantOrderNo;

  if (!merchantOrderNo) {
    throw new AppError(400, "PAYMENT_ORDER_MISSING", "藍新回傳缺少商店訂單編號");
  }

  return prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { providerOrderNo: merchantOrderNo }
    });

    if (!payment) {
      throw new AppError(404, "PAYMENT_NOT_FOUND", "找不到付款紀錄");
    }

    const amount = Number(result.Amt ?? 0);
    if (payment.amountTotal !== amount) {
      throw new AppError(400, "PAYMENT_AMOUNT_MISMATCH", "付款金額與訂單不一致");
    }

    if (payment.status === PaymentStatus.PAID && payment.creditsGranted > 0) {
      return { credited: false, paymentId: payment.id };
    }

    const creditsToGrant =
      payment.creditsGranted > 0 ? 0 : payment.quantity || eventCreditQuantity;

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.PAID,
        creditsGranted: payment.creditsGranted + creditsToGrant,
        providerTradeNo: result.TradeNo,
        paidAt: parseNewebPayDate(result.PayTime) ?? new Date()
      }
    });

    if (creditsToGrant > 0) {
      await tx.user.update({
        where: { id: payment.userId },
        data: { eventCredits: { increment: creditsToGrant } }
      });
    }

    return { credited: creditsToGrant > 0, paymentId: payment.id };
  });
}

export const billingService = {
  listPricingTiers() {
    return pricingTiers;
  },

  async getStatus(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        eventCredits: true,
        payments: {
          orderBy: { createdAt: "desc" },
          take: 8
        }
      }
    });

    if (!user) {
      throw new AppError(404, "USER_NOT_FOUND", "找不到使用者");
    }

    return {
      eventCredits: user.eventCredits,
      recentPayments: user.payments.map(toPaymentDTO)
    };
  },

  async createCheckoutSession(userId: string, tierId: string) {
    const config = requireNewebPayConfig();
    const tier = getPricingTier(tierId);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true }
    });

    if (!user) {
      throw new AppError(404, "USER_NOT_FOUND", "找不到使用者");
    }

    const merchantOrderNo = createMerchantOrderNo();
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        provider,
        product: PaymentProduct.EVENT_CREDIT,
        quantity: eventCreditQuantity,
        status: PaymentStatus.PENDING,
        amountTotal: tier.amount,
        currency: tier.currency,
        pricingTier: tier.id,
        attendeeLimit: tier.attendeeLimit,
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
        ItemDesc: `MonMate ${tier.label}額度`,
        ReturnURL: appUrl(env.API_BASE_URL, "/billing/newebpay/return"),
        NotifyURL: appUrl(env.API_BASE_URL, "/billing/newebpay/notify"),
        ClientBackURL: appUrl(env.WEB_APP_URL, "/admin/events/new"),
        LoginType: "0",
        CREDIT: "1",
        WEBATM: "0",
        VACC: "0",
        CVS: "0",
        BARCODE: "0"
      },
      config.hashKey,
      config.hashIv
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

    if (!tradeInfo || !tradeSha) {
      throw new AppError(400, "NEWEBPAY_PAYLOAD_INVALID", "藍新回傳資料不完整");
    }

    const expectedSha = createTradeSha(tradeInfo, config.hashKey, config.hashIv);
    if (tradeSha.toUpperCase() !== expectedSha) {
      throw new AppError(400, "NEWEBPAY_SIGNATURE_INVALID", "藍新回傳簽章不一致");
    }

    const decoded = decryptTradeInfo(tradeInfo, config.hashKey, config.hashIv);
    const result = getNewebPayResult(decoded);

    if (result.MerchantID && result.MerchantID !== config.merchantId) {
      throw new AppError(400, "NEWEBPAY_MERCHANT_INVALID", "藍新商店代號不一致");
    }

    if (decoded.Status === "SUCCESS") {
      const applied = await applyPaidPayment(decoded);
      return { received: true, status: decoded.Status, ...applied };
    }

    if (result.MerchantOrderNo) {
      await prisma.payment.updateMany({
        where: {
          providerOrderNo: result.MerchantOrderNo,
          status: PaymentStatus.PENDING
        },
        data: { status: PaymentStatus.FAILED }
      });
    }

    return { received: true, status: decoded.Status ?? "FAILED" };
  },

  async getNewebPayReturnUrl(body: Record<string, unknown>) {
    try {
      const result = await this.handleNewebPayNotify(body);
      const payment = "paymentId" in result && result.paymentId ? "success" : "pending";
      return appUrl(env.WEB_APP_URL, `/admin/events/new?payment=${payment}`);
    } catch {
      return appUrl(env.WEB_APP_URL, "/admin/events/new?payment=failed");
    }
  }
};
