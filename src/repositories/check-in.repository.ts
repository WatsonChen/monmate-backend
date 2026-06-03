import type { CheckInLogStatus, CheckInMethod } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export const checkInRepository = {
  listLogs(eventId: string) {
    return prisma.checkInLog.findMany({
      where: { eventId },
      include: { attendee: true },
      orderBy: { createdAt: "desc" }
    });
  },

  createLog(input: {
    eventId: string;
    attendeeId?: string;
    method: CheckInMethod;
    status: CheckInLogStatus;
    checkedInAt?: Date;
  }) {
    return prisma.checkInLog.create({
      data: {
        eventId: input.eventId,
        attendeeId: input.attendeeId,
        method: input.method,
        status: input.status,
        checkedInAt: input.checkedInAt
      }
    });
  }
};
