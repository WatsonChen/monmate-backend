import { Router } from "express";
import { attendeeRouter } from "./attendee.routes.js";
import { authRouter } from "./auth.routes.js";
import { billingRouter } from "./billing.routes.js";
import { checkInRouter } from "./check-in.routes.js";
import { eventRouter } from "./event.routes.js";
import { notificationRouter } from "./notification.routes.js";
import { surveyRouter } from "./survey.routes.js";

export const routes = Router();

routes.use("/auth", authRouter);
routes.use("/billing", billingRouter);
routes.use("/events/:eventId/attendees", attendeeRouter);
routes.use("/events/:eventId/check-in", checkInRouter);
routes.use("/events/:eventId/notifications", notificationRouter);
routes.use("/events/:eventId/survey", surveyRouter);
routes.use("/events", eventRouter);
