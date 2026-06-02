import { env } from "../config/env";

export type SmsTemplate = "with-registration" | "without-registration";

export interface SendSmsOptions {
  phone: string;
  attendeeName: string;
  eventName: string;
  eventDate: string;
  ticketUrl: string;
  template: SmsTemplate;
}

function buildMessage(opts: SendSmsOptions): string {
  if (opts.template === "with-registration") {
    return `【MonMate】${opts.attendeeName} 您好，您已受邀參加「${opts.eventName}」(${opts.eventDate})。請點擊連結完成報名並取得報到 QR Code：${opts.ticketUrl}`;
  }
  return `【MonMate】${opts.attendeeName} 您好，您已報名「${opts.eventName}」(${opts.eventDate})。報到 QR Code：${opts.ticketUrl}`;
}

async function sendViaTwilio(to: string, body: string): Promise<void> {
  const accountSid = (env as { TWILIO_ACCOUNT_SID?: string }).TWILIO_ACCOUNT_SID;
  const authToken = (env as { TWILIO_AUTH_TOKEN?: string }).TWILIO_AUTH_TOKEN;
  const from = (env as { TWILIO_FROM_PHONE?: string }).TWILIO_FROM_PHONE;

  if (!accountSid || !authToken || !from) throw new Error("Twilio 環境變數未設定");

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString()
  });
  if (!resp.ok) throw new Error(`Twilio error: ${resp.status}`);
}

export const smsService = {
  async send(opts: SendSmsOptions): Promise<{ success: boolean; message: string; preview: string }> {
    const message = buildMessage(opts);

    if (env.NODE_ENV !== "production") {
      console.log(`[SMS Mock] To: ${opts.phone}\n${message}`);
      return { success: true, message: "已模擬發送（開發模式）", preview: message };
    }

    try {
      await sendViaTwilio(opts.phone, message);
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
