import { Router } from "express";
import { attendeeRouter } from "./attendee.routes";
import { authRouter } from "./auth.routes";
import { billingRouter } from "./billing.routes";
import { checkInRouter } from "./check-in.routes";
import { eventRouter } from "./event.routes";
import { notificationRouter } from "./notification.routes";

export const routes = Router();

routes.use("/auth", authRouter);
routes.use("/billing", billingRouter);
routes.use("/events/:eventId/attendees", attendeeRouter);
routes.use("/events/:eventId/check-in", checkInRouter);
routes.use("/events/:eventId/notifications", notificationRouter);
routes.use("/events", eventRouter);
