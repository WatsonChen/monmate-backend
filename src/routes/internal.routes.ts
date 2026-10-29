import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { AppError, ok } from "../lib/http.js";
import { maintenanceService } from "../services/maintenance.service.js";

export const internalRouter = Router();

// 排程專用：必須帶 Authorization: Bearer <CRON_SECRET>（Vercel Cron 在專案設定 CRON_SECRET 後會自動帶上）。
// 沒有設定密鑰、沒帶、或不符，一律同樣回 401 並拒絕執行；不回傳是哪一種，也不輸出密鑰。
function requireCronSecret(req: { headers: Record<string, unknown> }) {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  const header = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const digest = (v: string) => createHash("sha256").update(v).digest();
  const matches = timingSafeEqual(digest(given), digest(secret));
  if (!secret || !given || !matches) throw new AppError(401, "UNAUTHORIZED", "未授權");
}

internalRouter.get(
  "/cron/maintenance",
  asyncHandler(async (req, res) => {
    requireCronSecret(req);
    return ok(res, await maintenanceService.purgeExpired());
  })
);
