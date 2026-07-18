import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

const include = { _count: { select: { attendees: true, checkInLogs: true } } } as const;

export const eventRepository = {
  listByUser(userId: string) {
    return prisma.event.findMany({
      where: { createdById: userId },
      orderBy: { startAt: "desc" },
      include
    });
  },

  findById(id: string) {
    return prisma.event.findUnique({ where: { id }, include });
  },

  findBySlug(slug: string) {
    return prisma.event.findUnique({
      where: { slug },
      select: {
        id: true, name: true, slug: true, description: true, content: true,
        startAt: true, endAt: true, location: true, attendeeLimit: true,
        allowOverCapacity: true,
        registrationRequired: true, openRegistration: true, registrationFields: true
      }
    });
  },

  update(id: string, data: Prisma.EventUncheckedUpdateInput) {
    return prisma.event.update({ where: { id }, data, include });
  },

  delete(id: string) {
    return prisma.event.delete({ where: { id } });
  }
};
