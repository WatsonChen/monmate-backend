-- AlterEnum
ALTER TYPE "CheckInLogStatus" ADD VALUE 'NOT_STARTED';

-- AlterTable
ALTER TABLE "Event" ADD COLUMN "selfCheckInBufferMinutes" INTEGER;
