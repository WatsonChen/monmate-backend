import {
  CheckInLogStatus,
  CheckInMethod,
  CheckInStatus
} from "@prisma/client";
import { getPhoneLastThree } from "@monmate/utils";
import { prisma } from "../lib/prisma.js";
import { attendeeRepository } from "../repositories/attendee.repository.js";
import { checkInRepository } from "../repositories/check-in.repository.js";
import { AppError } from "../lib/http.js";

function buildAttendeePayload(attendee: Awaited<ReturnType<typeof attendeeRepository.findById>>) {
  if (!attendee) return undefined;
  return {
    id: attendee.id,
    name: attendee.name,
    phone: attendee.phone,
    phoneLastThree: getPhoneLastThree(attendee.phone),
    checkInStatus: attendee.checkInStatus,
    checkedInAt: attendee.checkedInAt?.toISOString() ?? null,
    customFields: (attendee.customFields as Record<string, string> | null) ?? null,
    note: attendee.note ?? null,
    checkInCapacity: attendee.checkInCapacity,
    checkInCount: attendee.checkInCount
  };
}

function buildResult(status: CheckInLogStatus, attendee?: Awaited<ReturnType<typeof attendeeRepository.findById>>) {
  return {
    status,
    attendee: buildAttendeePayload(attendee),
    checkedInAt: attendee?.checkedInAt?.toISOString()
  };
}

async function findAttendee(eventId: string, method: CheckInMethod, credential: string) {
  return method === CheckInMethod.QR_CODE
    ? attendeeRepository.findByQrToken(eventId, credential)
    : method === CheckInMethod.PHONE
    ? attendeeRepository.findByPhone(eventId, credential)
    : attendeeRepository.findByCheckInCode(eventId, credential);
}

export const checkInService = {
  // 查詢報名者資料，不觸發報到（供前台先預覽再選人數）
  async lookup(eventId: string, method: CheckInMethod, credential: string) {
    const normalizedCredential = credential.trim();
    if (!normalizedCredential) return buildResult(CheckInLogStatus.INVALID);
    const attendee = await findAttendee(eventId, method, normalizedCredential);
    if (!attendee) return buildResult(CheckInLogStatus.NOT_FOUND);
    // 全員已到
    if (attendee.checkInCount >= attendee.checkInCapacity) {
      return buildResult(CheckInLogStatus.ALREADY_CHECKED_IN, attendee);
    }
    // 回傳 SUCCESS 但不寫 log、不更新計數（前台用來預覽）
    return { ...buildResult(CheckInLogStatus.SUCCESS, attendee), isLookup: true };
  },

  async byQrToken(eventId: string, qrToken: string, count = 1) {
    return this.checkIn(eventId, CheckInMethod.QR_CODE, qrToken, count);
  },

  async byManualCode(eventId: string, checkInCode: string, count = 1) {
    return this.checkIn(eventId, CheckInMethod.MANUAL_CODE, checkInCode, count);
  },

  async byPhone(eventId: string, phone: string, count = 1) {
    return this.checkIn(eventId, CheckInMethod.PHONE, phone, count);
  },

  async bySelfCheckIn(eventId: string, venueCode: string, credential: { phone: string } | { checkInCode: string }) {
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { venueCode: true } });
    if (!event || event.venueCode !== venueCode) {
      throw new AppError(403, "INVALID_VENUE_CODE", "現場驗證碼不正確，請至活動現場掃描 QR Code 完成報到");
    }
    if ("phone" in credential) {
      return this.checkIn(eventId, CheckInMethod.PHONE, credential.phone, 1);
    }
    return this.checkIn(eventId, CheckInMethod.MANUAL_CODE, credential.checkInCode, 1);
  },

  async checkIn(eventId: string, method: CheckInMethod, credential: string, count = 1) {
    const normalizedCredential = credential.trim();

    if (!normalizedCredential) {
      await checkInRepository.createLog({ eventId, method, status: CheckInLogStatus.INVALID });
      return buildResult(CheckInLogStatus.INVALID);
    }

    const attendee = await findAttendee(eventId, method, normalizedCredential);

    if (!attendee) {
      await checkInRepository.createLog({ eventId, method, status: CheckInLogStatus.NOT_FOUND });
      return buildResult(CheckInLogStatus.NOT_FOUND);
    }

    // 全員已到
    if (attendee.checkInCount >= attendee.checkInCapacity) {
      await checkInRepository.createLog({
        eventId, attendeeId: attendee.id, method,
        status: CheckInLogStatus.ALREADY_CHECKED_IN,
        checkedInAt: attendee.checkedInAt ?? undefined
      });
      return buildResult(CheckInLogStatus.ALREADY_CHECKED_IN, attendee);
    }

    // 限制 count 不超過剩餘容量
    const remaining = attendee.checkInCapacity - attendee.checkInCount;
    const actualCount = Math.min(count, remaining);
    const checkedInAt = attendee.checkedInAt ?? new Date();

    const updatedAttendee = await prisma.$transaction(async (tx) => {
      const updated = await tx.attendee.update({
        where: { id: attendee.id },
        data: {
          checkInCount: { increment: actualCount },
          checkInStatus: CheckInStatus.CHECKED_IN,
          checkedInAt: attendee.checkedInAt ?? checkedInAt
        }
      });

      await tx.checkInLog.create({
        data: { eventId, attendeeId: attendee.id, method, status: CheckInLogStatus.SUCCESS, checkedInAt }
      });

      return updated;
    });

    return buildResult(CheckInLogStatus.SUCCESS, updatedAttendee);
  },

  listLogs(eventId: string) {
    return checkInRepository.listLogs(eventId);
  }
};
