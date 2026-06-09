import { prisma } from "../lib/prisma.js";
import { env } from "../config/env.js";
import { emailService } from "./email.service.js";

export const notificationService = {
  async sendPreEvent(eventId: string): Promise<{ sent: number; failed: number; skipped: number }> {
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { name: true, startAt: true, location: true }
    });
    if (!event) throw new Error("找不到活動");

    const attendees = await prisma.attendee.findMany({
      where: { eventId, email: { not: null } },
      select: { email: true, name: true, qrToken: true }
    });

    const skipped = (
      await prisma.attendee.count({ where: { eventId, email: null } })
    );

    const eventDate = event.startAt.toLocaleDateString("zh-TW", {
      year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Asia/Taipei"
    });

    const items = attendees.map((a) => ({
      to: a.email!,
      attendeeName: a.name,
      eventName: event.name,
      eventDate,
      eventLocation: event.location ?? undefined,
      ticketUrl: `${env.WEB_APP_URL}/ticket?token=${a.qrToken}`,
      template: "pre-event-reminder" as const
    }));

    const result = await emailService.sendBulk(items);
    return { ...result, skipped };
  },

  async sendInviteEmails(
    eventId: string,
    attendeeIds: string[],
    registrationRequired: boolean
  ): Promise<{ sent: number; failed: number; skipped: number }> {
    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { name: true, startAt: true, location: true }
    });
    if (!event) throw new Error("找不到活動");

    const attendees = await prisma.attendee.findMany({
      where: {
        id: { in: attendeeIds },
        eventId,
        email: { not: null }
      },
      select: { email: true, name: true, qrToken: true }
    });

    const skipped = attendeeIds.length - attendees.length;

    const eventDate = event.startAt.toLocaleDateString("zh-TW", {
      year: "numeric", month: "long", day: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Asia/Taipei"
    });

    const template = registrationRequired
      ? ("invite-with-registration" as const)
      : ("invite-without-registration" as const);

    const items = attendees.map((a) => ({
      to: a.email!,
      attendeeName: a.name,
      eventName: event.name,
      eventDate,
      eventLocation: event.location ?? undefined,
      ticketUrl: `${env.WEB_APP_URL}/ticket?token=${a.qrToken}`,
      template
    }));

    const result = await emailService.sendBulk(items);
    return { ...result, skipped };
  }
};
