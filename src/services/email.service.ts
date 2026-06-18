import { Resend } from "resend";
import { env } from "../config/env.js";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;
const FROM = "MonMate <noreply@monmate.tw>";

export type EmailTemplate = "with-registration" | "without-registration";

export interface SendEmailOptions {
  to: string;
  attendeeName: string;
  eventName: string;
  eventDate: string;
  ticketUrl: string;
  template: EmailTemplate;
}

function buildSubject(opts: SendEmailOptions): string {
  return `【MonMate】${opts.eventName} — 您的${opts.template === "with-registration" ? "報名連結" : "票券"}`;
}

function buildHtml(opts: SendEmailOptions): string {
  const actionLabel = opts.template === "with-registration" ? "完成報名 & 取得票券" : "查看票券 / QR Code";
  const intro = opts.template === "with-registration"
    ? `您受邀參加「${opts.eventName}」(${opts.eventDate})，請點擊下方連結完成報名並取得報到 QR Code。`
    : `您已報名「${opts.eventName}」(${opts.eventDate})，請點擊下方連結查看票券及報到 QR Code。`;
  return `
    <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#f97316;margin-top:0">${opts.eventName}</h2>
      <p style="font-size:15px">${opts.attendeeName} 您好，</p>
      <p style="font-size:15px;line-height:1.7">${intro}</p>
      <p style="margin:28px 0">
        <a href="${opts.ticketUrl}"
           style="background:#f97316;color:white;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px">
          ${actionLabel}
        </a>
      </p>
      <p style="color:#999;font-size:12px">此連結由 MonMate 系統代為寄送，如有疑問請聯繫活動主辦方。</p>
    </div>
  `;
}

export const emailService = {
  async send(opts: SendEmailOptions): Promise<{ success: boolean; message: string }> {
    if (!resend) {
      if (env.NODE_ENV !== "production") {
        console.log(`[Email Mock] To: ${opts.to} | ${buildSubject(opts)}`);
        return { success: true, message: "已模擬發送（開發模式）" };
      }
      return { success: false, message: "Email 服務未設定 (RESEND_API_KEY)" };
    }
    try {
      await resend.emails.send({ from: FROM, to: opts.to, subject: buildSubject(opts), html: buildHtml(opts) });
      return { success: true, message: "Email 已發送" };
    } catch (err) {
      console.error("[Email] 發送失敗:", err);
      return { success: false, message: "Email 發送失敗" };
    }
  },

  async sendBulk(items: SendEmailOptions[]): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;
    for (const item of items) {
      const result = await this.send(item);
      if (result.success) sent++; else failed++;
    }
    return { sent, failed };
  },

  async sendPreEvent(opts: {
    to: string;
    attendeeName: string;
    eventName: string;
    eventDate: string;
    content: string;
    ticketUrl: string;
  }): Promise<{ success: boolean; message: string }> {
    if (!resend) {
      if (env.NODE_ENV !== "production") {
        console.log(`[Email Mock] Pre-event to: ${opts.to}`);
        return { success: true, message: "已模擬發送（開發模式）" };
      }
      return { success: false, message: "Email 服務未設定 (RESEND_API_KEY)" };
    }
    try {
      await resend.emails.send({
        from: FROM,
        to: opts.to,
        subject: `【MonMate】${opts.eventName} 行前通知`,
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px">
            <h2 style="color:#f97316;margin-top:0">${opts.eventName}</h2>
            <p style="font-size:15px">${opts.attendeeName} 您好，</p>
            <div style="font-size:15px;line-height:1.8;white-space:pre-wrap">${opts.content}</div>
            <hr style="margin:24px 0;border:none;border-top:1px solid #eee" />
            <p style="margin:20px 0">
              <a href="${opts.ticketUrl}"
                 style="background:#f97316;color:white;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:15px">
                查看票券 / QR Code
              </a>
            </p>
            <p style="color:#999;font-size:12px">此連結由 MonMate 系統代為寄送，如有疑問請聯繫活動主辦方。</p>
          </div>
        `
      });
      return { success: true, message: "Email 已發送" };
    } catch (err) {
      console.error("[Email] Pre-event 發送失敗:", err);
      return { success: false, message: "Email 發送失敗" };
    }
  }
};
