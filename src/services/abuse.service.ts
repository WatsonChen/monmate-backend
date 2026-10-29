import type { AbuseEventType, Prisma } from "@prisma/client";
import { getAbuseConfig } from "../config/abuse.js";
import { env } from "../config/env.js";
import { AppError } from "../lib/http.js";
import { hashIp } from "../lib/client-ip.js";
import { normalizePhone } from "../lib/identity.js";
import { prisma } from "../lib/prisma.js";
import { emailService } from "./email.service.js";
import { hit, rateLimited } from "./rate-limit.service.js";

async function record(
  eventId: string,
  type: AbuseEventType,
  detail?: Prisma.InputJsonValue,
  actorUserId?: string
) {
  return prisma.abuseEvent.create({ data: { eventId, type, detail, actorUserId } });
}

// 大量重複事件（例如被限流的請求）在冷卻期內只留一筆紀錄，避免紀錄表被灌爆
async function recordOncePerCooldown(eventId: string, type: AbuseEventType, detail: Prisma.InputJsonValue) {
  const { cooldownSeconds } = getAbuseConfig().alerts;
  if ((await hit(`abuse-log:${eventId}:${type}`, cooldownSeconds)) === 1) {
    await record(eventId, type, detail);
  }
}

// 告警 Email 的冷卻以資料庫單一條件更新做原子判斷：同一活動在冷卻期內只會有一個請求取得寄信資格
async function claimAlertSlot(eventId: string) {
  const { cooldownSeconds } = getAbuseConfig().alerts;
  const cutoff = new Date(Date.now() - cooldownSeconds * 1000);
  const claimed = await prisma.event.updateMany({
    where: { id: eventId, OR: [{ lastAbuseAlertAt: null }, { lastAbuseAlertAt: { lt: cutoff } }] },
    data: { lastAbuseAlertAt: new Date() }
  });
  return claimed.count === 1;
}

async function alert(eventId: string, kind: "EVENT" | "IP", count: number, windowMinutes: number, ipHash?: string) {
  const row = await record(eventId, kind === "EVENT" ? "RATE_ALERT_EVENT" : "RATE_ALERT_IP", {
    count,
    windowMinutes,
    ...(ipHash ? { ipHash } : {})
  });
  if (!(await claimAlertSlot(eventId))) return;
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { name: true, createdBy: { select: { email: true } } }
  });
  if (!event) return;
  const sent = await emailService
    .sendAbuseAlert({
      to: event.createdBy.email,
      eventName: event.name,
      kind,
      count,
      windowMinutes,
      manageUrl: `${env.WEB_APP_URL.replace(/\/$/, "")}/admin/events/${eventId}`
    })
    .catch(() => ({ success: false }));
  if (sent.success) await prisma.abuseEvent.update({ where: { id: row.id }, data: { notified: true } });
}

export const abuseService = {
  // 硬性速率限制：總請求（活動、同電話、來源 IP）分開計算，超過回 429。
  // 驗證失敗與成功新增另有各自的計數，見 recordCaptchaFailure / afterSuccessfulRegistration。
  async enforcePublicRegistrationLimits(input: { eventId: string; phone: string; ip: string | null }) {
    const { limits } = getAbuseConfig();
    const checks: [string, number, number][] = [
      [`reg:evt:${input.eventId}`, 60, limits.eventPerMinute],
      [`reg:ph:${input.eventId}:${normalizePhone(input.phone)}`, 60, limits.phonePerMinute]
    ];
    if (input.ip) checks.push([`reg:ip:${hashIp(input.ip)}`, 60, limits.ipPerMinute]);

    let limited: string | null = null;
    for (const [key, windowSeconds, max] of checks) {
      if ((await hit(key, windowSeconds)) > max) limited ??= key.split(":")[1];
    }
    if (limited) {
      await recordOncePerCooldown(input.eventId, "RATE_LIMITED", { scope: limited });
      throw rateLimited();
    }
  },

  // 驗證碼失敗的速率：不管 Turnstile 有沒有啟用，失敗請求本身都要計數並限流
  async recordCaptchaFailure(input: { eventId: string; ip: string | null }) {
    const { limits } = getAbuseConfig();
    await recordOncePerCooldown(input.eventId, "CAPTCHA_FAILED", {});
    if (input.ip) {
      if ((await hit(`reg-fail:${hashIp(input.ip)}`, 600)) > limits.captchaFailPer10Min) throw rateLimited();
    }
  },

  // 成功新增之後：只做觀察與告警（跨過門檻那一筆觸發一次），不封鎖、不暫停
  async afterSuccessfulRegistration(input: { eventId: string; ip: string | null }) {
    const { alerts } = getAbuseConfig();
    const eventCount = await hit(`reg-ok:evt:${input.eventId}`, 300);
    if (eventCount === alerts.eventSuccessPer5Min) await alert(input.eventId, "EVENT", eventCount, 5);
    if (input.ip) {
      const ipHash = hashIp(input.ip);
      const ipCount = await hit(`reg-ok:ip:${input.eventId}:${ipHash}`, 600);
      if (ipCount === alerts.ipSuccessPer10Min) await alert(input.eventId, "IP", ipCount, 10, ipHash);
    }
  },

  async pause(eventId: string, userId: string) {
    const updated = await prisma.event.updateMany({
      where: { id: eventId, publicRegistrationPausedAt: null },
      data: { publicRegistrationPausedAt: new Date(), publicRegistrationPausedById: userId }
    });
    if (updated.count === 1) await record(eventId, "REGISTRATION_PAUSED", {}, userId);
    return prisma.event.findUniqueOrThrow({ where: { id: eventId }, select: { publicRegistrationPausedAt: true } });
  },

  async resume(eventId: string, userId: string) {
    const updated = await prisma.event.updateMany({
      where: { id: eventId, publicRegistrationPausedAt: { not: null } },
      data: { publicRegistrationPausedAt: null, publicRegistrationPausedById: null }
    });
    if (updated.count === 1) await record(eventId, "REGISTRATION_RESUMED", {}, userId);
    return prisma.event.findUniqueOrThrow({ where: { id: eventId }, select: { publicRegistrationPausedAt: true } });
  },

  async list(eventId: string, take = 50) {
    return prisma.abuseEvent.findMany({
      where: { eventId },
      orderBy: { createdAt: "desc" },
      take,
      select: { id: true, type: true, detail: true, notified: true, createdAt: true }
    });
  },

  pausedError() {
    return new AppError(409, "REGISTRATION_PAUSED", "目前暫停接受新的報名，請聯絡主辦單位");
  }
};
