import {
  CheckInLogStatus,
  CheckInMethod,
  CheckInStatus
} from "@prisma/client";
import { getPhoneLastThree } from "@monmate/utils";
import { prisma } from "../lib/prisma";
import { attendeeRepository } from "../repositories/attendee.repository";
import { checkInRepository } from "../repositories/check-in.repository";

function buildResult(status: CheckInLogStatus, attendee?: Awaited<ReturnType<typeof attendeeRepository.findById>>) {
  return {
    status,
    attendee: attendee
      ? {
          id: attendee.id,
          name: attendee.name,
          phone: attendee.phone,
          phoneLastThree: getPhoneLastThree(attendee.phone),
          checkInStatus: attendee.checkInStatus,
          checkedInAt: attendee.checkedInAt?.toISOString() ?? null
        }
      : undefined,
    checkedInAt: attendee?.checkedInAt?.toISOString()
  };
}

export const checkInService = {
  async byQrToken(eventId: string, qrToken: string) {
    return this.checkIn(eventId, CheckInMethod.QR_CODE, qrToken);
  },

  async byManualCode(eventId: string, checkInCode: string) {
    return this.checkIn(eventId, CheckInMethod.MANUAL_CODE, checkInCode);
  },

  async checkIn(eventId: string, method: CheckInMethod, credential: string) {
    const normalizedCredential = credential.trim();

    if (!normalizedCredential) {
      await checkInRepository.createLog({
        eventId,
        method,
        status: CheckInLogStatus.INVALID
      });
      return buildResult(CheckInLogStatus.INVALID);
    }

    const attendee =
      method === CheckInMethod.QR_CODE
        ? await attendeeRepository.findByQrToken(eventId, normalizedCredential)
        : await attendeeRepository.findByCheckInCode(eventId, normalizedCredential);

    if (!attendee) {
      await checkInRepository.createLog({
        eventId,
        method,
        status: CheckInLogStatus.NOT_FOUND
      });
      return buildResult(CheckInLogStatus.NOT_FOUND);
    }

    if (attendee.checkInStatus === CheckInStatus.CHECKED_IN) {
      await checkInRepository.createLog({
        eventId,
        attendeeId: attendee.id,
        method,
        status: CheckInLogStatus.ALREADY_CHECKED_IN,
        checkedInAt: attendee.checkedInAt ?? undefined
      });
      return buildResult(CheckInLogStatus.ALREADY_CHECKED_IN, attendee);
    }

    const checkedInAt = new Date();
    const updatedAttendee = await prisma.$transaction(async (tx) => {
      const updated = await tx.attendee.update({
        where: { id: attendee.id },
        data: {
          checkInStatus: CheckInStatus.CHECKED_IN,
          checkedInAt
        }
      });

      await tx.checkInLog.create({
        data: {
          eventId,
          attendeeId: attendee.id,
          method,
          status: CheckInLogStatus.SUCCESS,
          checkedInAt
        }
      });

      return updated;
    });

    return buildResult(CheckInLogStatus.SUCCESS, updatedAttendee);
  },

  listLogs(eventId: string) {
    return checkInRepository.listLogs(eventId);
  }
};
