import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { billingService } from "../services/billing.service.js";

export const billingRouter = Router();

const checkoutSchema = z.object({
  tierId: z.string().min(1),
  returnTo: z.string().optional(),
  // 購買前使用者是否勾選同意退款條款，以及同意的條款版本（日期）。目前為選填以相容舊版前端，
  // 之後確認前端都已更新，可改為必填。
  acceptedRefundTerms: z.boolean().optional(),
  termsVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
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

billingRouter.get(
  "/transactions",
  asyncHandler(async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 50));
    const result = await billingService.listTransactions(req.user!.id, page, pageSize);
    return ok(res, result);
  })
);

billingRouter.post(
  "/checkout-session",
  asyncHandler(async (req, res) => {
    const body = checkoutSchema.parse(req.body);
    const session = await billingService.createCheckoutSession(
      req.user!.id,
      body.tierId,
      body.returnTo,
      body.acceptedRefundTerms ? { version: body.termsVersion ?? null } : undefined
    );
    return ok(res, session, 201);
  })
);

billingRouter.get(
  "/payments/:paymentId",
  asyncHandler(async (req, res) => {
    return ok(res, await billingService.getPayment(req.user!.id, req.params.paymentId));
  })
);
