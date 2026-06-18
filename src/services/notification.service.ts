import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { emailService } from "./email.service.js";

export const notificationService = {
  async sendPreEvent(eventId: string, content: string) {
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return { sent: 0, skipped: 0, message: "找不到活動" };

    const attendees = await prisma.attendee.findMany({
      where: { eventId, email: { not: null } },
      select: { name: true, email: true, qrToken: true }
    });

    const webUrl = env.WEB_APP_URL.replace(/\/$/, "");
    const eventDate = new Date(event.startAt).toLocaleDateString("zh-TW");
    let sent = 0;
    let skipped = 0;

    for (const a of attendees) {
      if (!a.email) { skipped++; continue; }
      const result = await emailService.sendPreEvent({
        to: a.email,
        attendeeName: a.name,
        eventName: event.name,
        eventDate,
        content,
        ticketUrl: `${webUrl}/event/${event.slug}?token=${a.qrToken}`
      });
      if (result.success) sent++; else skipped++;
    }

    return {
      sent,
      skipped,
      message: `已寄送 ${sent} 封行前通知${skipped > 0 ? `，${skipped} 筆無 Email 或發送失敗` : ""}`
    };
  }
};
