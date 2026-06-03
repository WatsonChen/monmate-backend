import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { billingService } from "../services/billing.service.js";

export const billingRouter = Router();

const checkoutSchema = z.object({
  tierId: z.string().min(1)
});

billingRouter.post(
  "/newebpay/notify",
  asyncHandler(async (req, res) => {
    await billingService.handleNewebPayNotify(req.body as Record<string, unknown>);
    return res.type("text/plain").send("1|OK");
  })
);

billingRouter.post(
  "/newebpay/return",
  asyncHandler(async (req, res) => {
    const returnUrl = await billingService.getNewebPayReturnUrl(
      req.body as Record<string, unknown>
    );
    return res.status(303).setHeader("Location", returnUrl).send();
  })
);

billingRouter.use(requireAuth);

billingRouter.get(
  "/pricing-tiers",
  asyncHandler(async (_req, res) => {
    return ok(res, billingService.listPricingTiers());
  })
);

billingRouter.get(
  "/status",
  asyncHandler(async (req, res) => {
    const status = await billingService.getStatus(req.user!.id);
    return ok(res, status);
  })
);

billingRouter.post(
  "/checkout-session",
  asyncHandler(async (req, res) => {
    const body = checkoutSchema.parse(req.body);
    const session = await billingService.createCheckoutSession(
      req.user!.id,
      body.tierId
    );
    return ok(res, session, 201);
  })
);
