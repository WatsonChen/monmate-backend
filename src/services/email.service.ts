import { Resend } from "resend";
import { env } from "../config/env.js";

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

export type EmailTemplate = "invite-with-registration" | "invite-without-registration" | "pre-event-reminder";

export interface SendEmailOptions {
  to: string;
  attendeeName: string;
  eventName: string;
  eventDate: string;
  eventLocation?: string;
  ticketUrl: string;
  template: EmailTemplate;
}

function buildSubject(opts: SendEmailOptions): string {
  if (opts.template === "pre-event-reminder") return `【提醒】明天見！${opts.eventName}`;
  if (opts.template === "invite-with-registration") return `您受邀參加「${opts.eventName}」，請完成報名`;
  return `您已報名「${opts.eventName}」— 報到 QR Code`;
}

function buildHtml(opts: SendEmailOptions): string {
  const locationLine = opts.eventLocation
    ? `<p style="margin:0 0 8px"><strong>地點：</strong>${opts.eventLocation}</p>`
    : "";

  const ctaLabel =
    opts.template === "invite-with-registration"
      ? "立即報名並取得 QR Code"
      : opts.template === "pre-event-reminder"
      ? "查看我的 QR Code"
      : "查看報到 QR Code";

  const bodyText =
    opts.template === "invite-with-registration"
      ? `您好 <strong>${opts.attendeeName}</strong>，<br>您已受邀參加以下活動，請點擊下方按鈕完成報名並取得專屬報到 QR Code。`
      : opts.template === "pre-event-reminder"
      ? `您好 <strong>${opts.attendeeName}</strong>，<br>明天就是活動日！別忘了帶著您的報到 QR Code 準時參加。`
      : `您好 <strong>${opts.attendeeName}</strong>，<br>感謝您報名本次活動！以下是您的報到 QR Code，請於活動當天出示。`;

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 16px">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
        <tr>
          <td style="background:#18181b;padding:24px 32px">
            <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.5px">MonMate</p>
          </td>
        </tr>
        <tr>
          <td style="padding:32px">
            <p style="margin:0 0 20px;font-size:15px;line-height:1.7;color:#3f3f46">${bodyText}</p>
            <table cellpadding="0" cellspacing="0" style="background:#fafafa;border:1px solid #e4e4e7;border-radius:8px;padding:16px 20px;margin-bottom:24px;width:100%">
              <tr><td>
                <p style="margin:0 0 8px;font-size:17px;font-weight:700;color:#18181b">${opts.eventName}</p>
                <p style="margin:0 0 8px"><strong>日期：</strong>${opts.eventDate}</p>
                ${locationLine}
              </td></tr>
            </table>
            <table cellpadding="0" cellspacing="0">
              <tr><td style="background:#18181b;border-radius:8px">
                <a href="${opts.ticketUrl}" style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">${ctaLabel}</a>
              </td></tr>
            </table>
            <p style="margin:28px 0 0;font-size:13px;color:#a1a1aa">如無法點擊按鈕，請複製以下連結到瀏覽器：<br>
              <a href="${opts.ticketUrl}" style="color:#71717a;word-break:break-all">${opts.ticketUrl}</a>
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #f4f4f5">
            <p style="margin:0;font-size:12px;color:#a1a1aa">此郵件由 MonMate 自動發送，請勿直接回覆。</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendViaResend(opts: SendEmailOptions): Promise<void> {
  if (!resend) throw new Error("RESEND_API_KEY 未設定");
  const { error } = await resend.emails.send({
    from: env.EMAIL_FROM,
    to: opts.to,
    subject: buildSubject(opts),
    html: buildHtml(opts)
  });
  if (error) throw new Error(`Resend error: ${error.message}`);
}

export const emailService = {
  async send(opts: SendEmailOptions): Promise<{ success: boolean; message: string }> {
    if (env.NODE_ENV !== "production") {
      console.log(`[Email Mock] To: ${opts.to} | ${buildSubject(opts)}`);
      return { success: true, message: "已模擬發送（開發模式）" };
    }
    try {
      await sendViaResend(opts);
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
  }
};
