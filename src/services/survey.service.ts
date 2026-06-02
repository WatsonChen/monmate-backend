import { AppError } from "../lib/http";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { smsService } from "./sms.service";

export const surveyService = {
  async getOrCreate(eventId: string) {
    const existing = await prisma.survey.findUnique({
      where: { eventId },
      include: { questions: { orderBy: { order: "asc" } } }
    });
    if (existing) return existing;

    return prisma.survey.create({
      data: {
        eventId,
        title: "活動問卷",
        questions: {
          create: [
            { question: "您對本次活動的整體滿意度？", type: "rating", options: [], order: 1 },
            { question: "您最喜歡哪個環節？", type: "text", options: [], order: 2 },
            { question: "您有什麼建議或回饋？", type: "text", options: [], order: 3 }
          ]
        }
      },
      include: { questions: { orderBy: { order: "asc" } } }
    });
  },

  async update(surveyId: string, input: { title?: string; questions?: Array<{ id?: string; question: string; type: string; options: string[]; order: number }> }) {
    const survey = await prisma.survey.findUnique({ where: { id: surveyId } });
    if (!survey) throw new AppError(404, "SURVEY_NOT_FOUND", "找不到問卷");

    return prisma.$transaction(async (tx) => {
      if (input.title) {
        await tx.survey.update({ where: { id: surveyId }, data: { title: input.title } });
      }
      if (input.questions) {
        await tx.surveyQuestion.deleteMany({ where: { surveyId } });
        await tx.surveyQuestion.createMany({
          data: input.questions.map((q) => ({ surveyId, question: q.question, type: q.type, options: q.options, order: q.order }))
        });
      }
      return tx.survey.findUnique({ where: { id: surveyId }, include: { questions: { orderBy: { order: "asc" } } } });
    });
  },

  async sendSurvey(eventId: string) {
    const survey = await prisma.survey.findUnique({ where: { eventId } });
    if (!survey) throw new AppError(404, "SURVEY_NOT_FOUND", "找不到問卷");

    const event = await prisma.event.findUnique({
      where: { id: eventId },
      select: { name: true, startAt: true, slug: true }
    });
    if (!event) throw new AppError(404, "EVENT_NOT_FOUND", "找不到活動");

    const attendees = await prisma.attendee.findMany({
      where: { eventId, checkInStatus: "CHECKED_IN" },
      select: { id: true, name: true, phone: true, qrToken: true }
    });

    const webUrl = env.WEB_APP_URL.replace(/\/$/, "");
    const results = await smsService.sendBulk(
      attendees.map((a) => ({
        phone: a.phone,
        attendeeName: a.name,
        eventName: event.name,
        eventDate: event.startAt.toLocaleDateString("zh-TW"),
        ticketUrl: `${webUrl}/event/${event.slug}/survey?token=${a.qrToken}`,
        template: "without-registration" as const
      }))
    );

    await prisma.survey.update({ where: { id: survey.id }, data: { sentAt: new Date() } });
    return { ...results, surveyId: survey.id };
  },

  async submitResponse(surveyId: string, attendeeId: string | undefined, answers: Record<string, unknown>) {
    const survey = await prisma.survey.findUnique({ where: { id: surveyId } });
    if (!survey) throw new AppError(404, "SURVEY_NOT_FOUND", "找不到問卷");

    const response = await prisma.surveyResponse.create({
      data: { surveyId, attendeeId, answers }
    });
    return { id: response.id };
  },

  async getResponses(surveyId: string) {
    return prisma.surveyResponse.findMany({
      where: { surveyId },
      include: { attendee: { select: { name: true, phone: true } } },
      orderBy: { createdAt: "desc" }
    });
  },

  async getPublicSurvey(eventId: string, qrToken: string) {
    const attendee = await prisma.attendee.findFirst({ where: { eventId, qrToken } });
    if (!attendee) throw new AppError(404, "ATTENDEE_NOT_FOUND", "找不到報名資料");

    const survey = await prisma.survey.findUnique({
      where: { eventId },
      include: { questions: { orderBy: { order: "asc" } } }
    });
    if (!survey) throw new AppError(404, "SURVEY_NOT_FOUND", "找不到問卷");

    return { survey, attendeeId: attendee.id, attendeeName: attendee.name };
  }
};
