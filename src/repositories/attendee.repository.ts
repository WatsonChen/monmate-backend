import { CheckInStatus, type Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

export const attendeeRepository = {
  list(eventId: string, search?: string, status?: CheckInStatus) {
    return prisma.attendee.findMany({
      where: {
        eventId,
        checkInStatus: status,
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { phone: { contains: search } },
                { checkInCode: { contains: search, mode: "insensitive" } }
              ]
            }
          : {})
      },
      orderBy: { createdAt: "desc" }
    });
  },

  findById(id: string) {
    return prisma.attendee.findUnique({ where: { id } });
  },

  findByQrToken(eventId: string, qrToken: string) {
    return prisma.attendee.findUnique({
      where: { eventId_qrToken: { eventId, qrToken } }
    });
  },

  findByCheckInCode(eventId: string, checkInCode: string) {
    return prisma.attendee.findUnique({
      where: { eventId_checkInCode: { eventId, checkInCode } }
    });
  },

  createMany(data: Prisma.AttendeeCreateManyInput[]) {
    return prisma.attendee.createMany({ data, skipDuplicates: true });
  },

  update(id: string, data: Prisma.AttendeeUpdateInput) {
    return prisma.attendee.update({ where: { id }, data });
  }
};
