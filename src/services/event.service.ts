import { createSlug } from "@monmate/utils";
import { AppError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { eventRepository } from "../repositories/event.repository.js";

type EventWithCounts = NonNullable<Awaited<ReturnType<typeof eventRepository.findById>>>;

function toEventDTO(event: EventWithCounts) {
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    description: event.description,
    content: event.content,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt?.toISOString() ?? null,
    location: event.location,
    attendeeLimit: event.attendeeLimit,
    registrationRequired: event.registrationRequired,
    openRegistration: event.openRegistration,
    registrationFields: event.registrationFields as RegistrationField[],
    attendeeCount: event._count.attendees,
    checkInLogCount: event._count.checkInLogs,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString()
  };
}

export type RegistrationField = {
  key: string;
  label?: string;
  type?: "text" | "number" | "select";
  options?: string[];
  required: boolean;
};

export const eventService = {
  async list(userId: string) {
    const events = await eventRepository.listByUser(userId);
    return events.map(toEventDTO);
  },

  async get(eventId: string) {
    const event = await eventRepository.findById(eventId);
    if (!event) throw new AppError(404, "EVENT_NOT_FOUND", "找不到活動");
    return toEventDTO(event);
  },

  async getPublicBySlug(slug: string) {
    const event = await eventRepository.findBySlug(slug);
    if (!event) throw new AppError(404, "EVENT_NOT_FOUND", "找不到活動");
    return {
      id: event.id,
      name: event.name,
      slug: event.slug,
      description: event.description,
      content: event.content,
      startAt: event.startAt.toISOString(),
      endAt: event.endAt?.toISOString() ?? null,
      location: event.location,
      attendeeLimit: event.attendeeLimit,
      registrationRequired: event.registrationRequired,
      openRegistration: event.openRegistration,
      registrationFields: event.registrationFields as RegistrationField[]
    };
  },

  async create(input: {
    name: string;
    slug?: string;
    description?: string;
    content?: string;
    startAt: string;
    endAt?: string;
    location?: string;
    attendeeLimit?: number;
    registrationRequired?: boolean;
    openRegistration?: boolean;
    registrationFields?: RegistrationField[];
    createdById: string;
  }) {
    const slug = input.slug?.trim() || createSlug(input.name) || `event-${Date.now()}`;

    const event = await prisma.$transaction(async (tx) => {
      if (input.attendeeLimit && input.attendeeLimit > 0) {
        const user = await tx.user.findUnique({
          where: { id: input.createdById },
          select: { attendeeCredits: true }
        });
        if (!user) throw new AppError(404, "USER_NOT_FOUND", "找不到使用者");
        if (user.attendeeCredits < input.attendeeLimit) {
          throw new AppError(
            402,
            "INSUFFICIENT_ATTENDEE_CREDITS",
            `人次額度不足。需要 ${input.attendeeLimit} 個額度，目前剩餘 ${user.attendeeCredits} 個。`
          );
        }
        await tx.user.update({
          where: { id: input.createdById },
          data: { attendeeCredits: { decrement: input.attendeeLimit } }
        });
      }

      return tx.event.create({
        data: {
          name: input.name,
          slug,
          description: input.description,
          content: input.content,
          startAt: new Date(input.startAt),
          endAt: input.endAt ? new Date(input.endAt) : undefined,
          location: input.location,
          attendeeLimit: input.attendeeLimit,
          registrationRequired: input.registrationRequired ?? false,
          openRegistration: input.openRegistration ?? false,
          registrationFields: input.registrationFields ?? [],
          createdById: input.createdById
        },
        include: { _count: { select: { attendees: true, checkInLogs: true } } }
      });
    });

    return toEventDTO(event);
  },

  async update(
    eventId: string,
    input: Partial<{
      name: string;
      slug: string;
      description: string | null;
      content: string | null;
      startAt: string;
      endAt: string | null;
      location: string | null;
      registrationRequired: boolean;
      openRegistration: boolean;
      registrationFields: RegistrationField[];
    }>
  ) {
    await this.get(eventId);
    const event = await eventRepository.update(eventId, {
      ...input,
      startAt: input.startAt ? new Date(input.startAt) : undefined,
      endAt: input.endAt === null ? null : input.endAt ? new Date(input.endAt) : undefined
    });
    return toEventDTO(event);
  },

  async delete(eventId: string) {
    await this.get(eventId);
    await eventRepository.delete(eventId);
    return { id: eventId };
  },

  async getAnalytics(eventId: string) {
    const event = await this.get(eventId);
    const attendees = await prisma.attendee.findMany({
      where: { eventId },
      select: { checkInStatus: true, checkedInAt: true, age: true, gender: true }
    });

    const total = attendees.length;
    const checkedIn = attendees.filter((a) => a.checkInStatus === "CHECKED_IN").length;

    const ageGroups: Record<string, number> = {};
    const genderCounts: Record<string, number> = {};

    for (const a of attendees) {
      if (a.age) {
        const group =
          a.age < 20 ? "18歲以下" :
          a.age < 30 ? "20-29" :
          a.age < 40 ? "30-39" :
          a.age < 50 ? "40-49" : "50歲以上";
        ageGroups[group] = (ageGroups[group] ?? 0) + 1;
      }
      if (a.gender) {
        genderCounts[a.gender] = (genderCounts[a.gender] ?? 0) + 1;
      }
    }

    const checkInByHour: Record<number, number> = {};
    for (const a of attendees) {
      if (a.checkedInAt) {
        const hour = new Date(a.checkedInAt).getHours();
        checkInByHour[hour] = (checkInByHour[hour] ?? 0) + 1;
      }
    }

    return {
      eventId,
      eventName: event.name,
      total,
      checkedIn,
      notCheckedIn: total - checkedIn,
      checkInRate: total > 0 ? Math.round((checkedIn / total) * 100) : 0,
      ageGroups,
      genderCounts,
      checkInByHour
    };
  }
};
