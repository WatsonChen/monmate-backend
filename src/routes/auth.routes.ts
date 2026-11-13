import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/async-handler.js";
import { ok } from "../lib/http.js";
import { requireAuth } from "../middlewares/auth.js";
import { authService } from "../services/auth.service.js";
import { getClientIp } from "../lib/client-ip.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const result = await authService.login(body.email, body.password, getClientIp(req));
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

// 登出所有裝置（撤銷這個帳號所有已發出的登入憑證）；一般登出只是前端刪除本機憑證
authRouter.post(
  "/logout-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    return ok(res, await authService.logoutAll(req.user!.id));
  })
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await authService.me(req.user!.id);
    return ok(res, result);
  })
);
