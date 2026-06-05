import { env } from "../config/env.js";

export type SmsTemplate = "with-registration" | "without-registration";

export interface SendSmsOptions {
  phone: string;
  attendeeName: string;
  eventName: string;
  eventDate: string;
  ticketUrl: string;
  template: SmsTemplate;
  senderName?: string;
}

function normalizeTwPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (/^09\d{8}$/.test(digits)) return `09${digits.slice(2)}`;
  if (/^8869\d{8}$/.test(digits)) return `09${digits.slice(4)}`;
  if (/^\+8869\d{8}$/.test(phone.replace(/\s/g, ""))) return `09${digits.slice(4)}`;
  return digits;
}

function buildMessage(opts: SendSmsOptions): string {
  const tag = opts.senderName?.trim() || "MonMate";
  if (opts.template === "with-registration") {
    return `【${tag}】${opts.attendeeName} 您好，您已受邀參加「${opts.eventName}」(${opts.eventDate})。請點擊連結完成報名並取得報到 QR Code：${opts.ticketUrl}`;
  }
  return `【${tag}】${opts.attendeeName} 您好，您已報名「${opts.eventName}」(${opts.eventDate})。報到 QR Code：${opts.ticketUrl}`;
}

async function sendViaEvery8d(to: string, body: string): Promise<void> {
  const { EVERY8D_UID: uid, EVERY8D_PWD: pwd } = env;
  if (!uid || !pwd) throw new Error("every8d 環境變數未設定 (EVERY8D_UID / EVERY8D_PWD)");

  const dest = normalizeTwPhone(to);
  const resp = await fetch("https://api.every8d.com/API21/HTTP/sendSMS.ashx", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ UID: uid, PWD: pwd, MSG: body, DEST: dest, ST: "" }).toString()
  });

  const text = await resp.text();
  // every8d returns "CREDIT,SENDED,UNSEND,DETAIL" on success, or negative error code
  const credit = parseFloat(text.split(",")[0]);
  if (isNaN(credit) || credit < 0) {
    throw new Error(`every8d 錯誤：${text.trim()}`);
  }
}

export const smsService = {
  async send(opts: SendSmsOptions): Promise<{ success: boolean; message: string; preview: string }> {
    const message = buildMessage(opts);

    if (env.NODE_ENV !== "production") {
      console.log(`[SMS Mock] To: ${opts.phone} (→ ${normalizeTwPhone(opts.phone)})\n${message}`);
      return { success: true, message: "已模擬發送（開發模式）", preview: message };
    }

    try {
      await sendViaEvery8d(opts.phone, message);
      return { success: true, message: "簡訊已發送", preview: message };
    } catch (err) {
      console.error("[SMS] 發送失敗:", err);
      return { success: false, message: "簡訊發送失敗", preview: message };
    }
  },

  async sendBulk(items: SendSmsOptions[]): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const item of items) {
      const result = await this.send(item);
      if (result.success) sent++; else failed++;
    }
    return { sent, failed };
  }
};
