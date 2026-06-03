import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { surveyService } from "../services/survey.service.js";

export const surveyRouter = Router({ mergeParams: true });

surveyRouter.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const survey = await surveyService.getOrCreate(req.params.eventId);
    return ok(res, survey);
  })
);

surveyRouter.put(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const body = z.object({
      title: z.string().optional(),
      questions: z.array(z.object({
        id: z.string().optional(),
        question: z.string(),
        type: z.string(),
        options: z.array(z.string()),
        order: z.number()
      })).optional()
    }).parse(req.body);
    const survey = await surveyService.getOrCreate(req.params.eventId);
    const updated = await surveyService.update(survey.id, body);
    return ok(res, updated);
  })
);

surveyRouter.post(
  "/send",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await surveyService.sendSurvey(req.params.eventId);
    return ok(res, result);
  })
);

surveyRouter.get(
  "/responses",
  requireAuth,
  asyncHandler(async (req, res) => {
    const survey = await surveyService.getOrCreate(req.params.eventId);
    const responses = await surveyService.getResponses(survey.id);
    return ok(res, responses);
  })
);

surveyRouter.post(
  "/respond",
  asyncHandler(async (req, res) => {
    const body = z.object({
      surveyId: z.string(),
      attendeeId: z.string().optional(),
      answers: z.record(z.unknown())
    }).parse(req.body);
    const result = await surveyService.submitResponse(body.surveyId, body.attendeeId, body.answers);
    return ok(res, result);
  })
);

surveyRouter.get(
  "/public",
  asyncHandler(async (req, res) => {
    const { token } = z.object({ token: z.string() }).parse(req.query);
    const data = await surveyService.getPublicSurvey(req.params.eventId, token);
    return ok(res, data);
  })
);
