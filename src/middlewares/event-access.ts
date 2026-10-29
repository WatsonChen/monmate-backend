import type { NextFunction, Request, Response } from "express";
import { AppError } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";

// 活動不存在與「不是你的活動」一律回 404，避免外部用活動 ID 探測他人活動
const notFound = () => new AppError(404, "EVENT_NOT_FOUND", "找不到活動");

async function isEventOwner(userId: string, eventId: string) {
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { createdById: true } });
  if (!event) return null;
  return event.createdById === userId;
}

async function isAssignedStaff(userId: string, eventId: string) {
  const assignment = await prisma.eventStaffAssignment.findUnique({
    where: { eventId_userId: { eventId, userId } },
    select: { id: true }
  });
  if (assignment) return true;
  // 舊資料可能只有 User.assignedEventId
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { assignedEventId: true } });
  return user?.assignedEventId === eventId;
}

// 只有活動建立者：改設定、刪除、解鎖、名單匯入匯出、問卷、通知、工作人員管理
export function requireEventOwner(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new AppError(401, "UNAUTHORIZED", "請先登入"));
  isEventOwner(req.user.id, req.params.eventId)
    .then((owner) => next(owner ? undefined : notFound()))
    .catch(next);
}

// 活動建立者，或被指派到該活動的工作人員：報到、查名單、場地 QR
export function requireEventAccess(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new AppError(401, "UNAUTHORIZED", "請先登入"));
  const { id, role } = req.user;
  const { eventId } = req.params;

  const check = async () => {
    if (role === "STAFF") {
      if (await isAssignedStaff(id, eventId)) return true;
      return false;
    }
    return (await isEventOwner(id, eventId)) === true;
  };

  check()
    .then((allowed) => next(allowed ? undefined : role === "STAFF" ? new AppError(403, "FORBIDDEN", "無法操作非指派活動") : notFound()))
    .catch(next);
}
