import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler";
import { ok } from "../lib/http";
import { requireAuth } from "../middlewares/auth";
import { authService } from "../services/auth.service";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const result = await authService.login(body.email, body.password);
    return ok(res, result);
  })
);

authRouter.post(
  "/google",
  asyncHandler(async (req, res) => {
    const { credential } = z.object({ credential: z.string().min(1) }).parse(req.body);
    const result = await authService.googleLogin(credential);
    return ok(res, result);
  })
);

authRouter.post("/logout", (_req, res) => {
  return ok(res, { loggedOut: true });
});

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await authService.me(req.user!.id);
    return ok(res, result);
  })
);
