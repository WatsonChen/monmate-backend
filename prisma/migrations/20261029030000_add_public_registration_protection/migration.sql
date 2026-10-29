-- CreateEnum
CREATE TYPE "AbuseEventType" AS ENUM ('RATE_ALERT_EVENT', 'RATE_ALERT_IP', 'RATE_LIMITED', 'CAPTCHA_FAILED', 'REGISTRATION_PAUSED', 'REGISTRATION_RESUMED');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "publicRegistrationPausedAt" TIMESTAMP(3),
ADD COLUMN     "publicRegistrationPausedById" TEXT,
ADD COLUMN     "lastAbuseAlertAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RateLimitCounter" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("key","windowStart")
);

-- CreateTable
CREATE TABLE "AbuseEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" "AbuseEventType" NOT NULL,
    "detail" JSONB,
    "actorUserId" TEXT,
    "notified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AbuseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimitCounter_expiresAt_idx" ON "RateLimitCounter"("expiresAt");

-- CreateIndex
CREATE INDEX "AbuseEvent_eventId_createdAt_idx" ON "AbuseEvent"("eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "AbuseEvent" ADD CONSTRAINT "AbuseEvent_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
