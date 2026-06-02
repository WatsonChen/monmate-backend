import { createSlug } from "@monmate/utils";
import { PaymentProduct, PaymentStatus } from "@prisma/client";
import { AppError } from "../lib/http";
import { prisma } from "../lib/prisma";
import { eventRepository } from "../repositories/event.repository";

type EventWithCounts = NonNullable<
  Awaited<ReturnType<typeof eventRepository.findById>>
>;

function toEventDTO(event: EventWithCounts) {
  return {
    id: event.id,
    name: event.name,
    slug: event.slug,
    description: event.description,
    startAt: event.startAt.toISOString(),
    endAt: event.endAt?.toISOString() ?? null,
    location: event.location,
    attendeeLimit: event.attendeeLimit,
    attendeeCount: event._count.attendees,
    checkInLogCount: event._count.checkInLogs,
    createdAt: event.createdAt.toISOString(),
    updatedAt: event.updatedAt.toISOString()
  };
}

export const eventService = {
  async list() {
    const events = await eventRepository.list();
    return events.map(toEventDTO);
  },

  async get(eventId: string) {
    const event = await eventRepository.findById(eventId);

    if (!event) {
      throw new AppError(404, "EVENT_NOT_FOUND", "找不到活動");
    }

    return toEventDTO(event);
  },

  async getPublicBySlug(slug: string) {
    const event = await eventRepository.findBySlug(slug);

    if (!event) {
      throw new AppError(404, "EVENT_NOT_FOUND", "找不到活動");
    }

    return {
      ...event,
      startAt: event.startAt.toISOString(),
      endAt: event.endAt?.toISOString() ?? null
    };
  },

  async create(input: {
    name: string;
    slug?: string;
    description?: string;
    startAt: string;
    endAt?: string;
    location?: string;
    createdById: string;
  }) {
    const slug = input.slug?.trim() || createSlug(input.name);

    const event = await prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({
        where: {
          userId: input.createdById,
          product: PaymentProduct.EVENT_CREDIT,
          status: PaymentStatus.PAID,
          creditsGranted: { gt: 0 },
          consumedAt: null
        },
        orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }]
      });

      if (!payment) {
        throw new AppError(
          402,
          "EVENT_CREDIT_REQUIRED",
          "建立活動前請先完成單場儲值"
        );
      }

      const creditResult = await tx.user.updateMany({
        where: {
          id: input.createdById,
          eventCredits: { gt: 0 }
        },
        data: {
          eventCredits: { decrement: 1 }
        }
      });

      if (creditResult.count === 0) {
        throw new AppError(
          402,
          "EVENT_CREDIT_REQUIRED",
          "建立活動前請先完成單場儲值"
        );
      }

      const createdEvent = await tx.event.create({
        data: {
          name: input.name,
          slug,
          description: input.description,
          startAt: new Date(input.startAt),
          endAt: input.endAt ? new Date(input.endAt) : undefined,
          location: input.location,
          attendeeLimit: payment.attendeeLimit,
          paymentId: payment.id,
          createdById: input.createdById
        },
        include: {
          _count: {
            select: { attendees: true, checkInLogs: true }
          }
        }
      });

      const consumeResult = await tx.payment.updateMany({
        where: {
          id: payment.id,
          consumedAt: null
        },
        data: { consumedAt: new Date() }
      });

      if (consumeResult.count === 0) {
        throw new AppError(
          409,
          "EVENT_CREDIT_ALREADY_USED",
          "這筆活動額度已被使用，請重新整理後再試一次"
        );
      }

      return createdEvent;
    });

    return toEventDTO(event);
  },

  async update(
    eventId: string,
    input: Partial<{
      name: string;
      slug: string;
      description: string | null;
      startAt: string;
      endAt: string | null;
      location: string | null;
    }>
  ) {
    await this.get(eventId);

    const event = await eventRepository.update(eventId, {
      ...input,
      startAt: input.startAt ? new Date(input.startAt) : undefined,
      endAt:
        input.endAt === null
          ? null
          : input.endAt
            ? new Date(input.endAt)
            : undefined
    });

    return toEventDTO(event);
  },

  async delete(eventId: string) {
    await this.get(eventId);
    await eventRepository.delete(eventId);
    return { id: eventId };
  }
};
