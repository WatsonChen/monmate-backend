-- CreateEnum
CREATE TYPE "ImportSessionStatus" AS ENUM ('PREVIEW', 'CONFIRMED');

-- AlterTable
ALTER TABLE "CreditTransaction" ADD COLUMN     "importSessionId" TEXT;

-- CreateTable
CREATE TABLE "ImportSession" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "status" "ImportSessionStatus" NOT NULL DEFAULT 'PREVIEW',
    "rows" JSONB NOT NULL,
    "rowErrors" JSONB NOT NULL,
    "decisions" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportSession_eventId_createdAt_idx" ON "ImportSession"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "ImportSession_status_expiresAt_idx" ON "ImportSession"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "CreditTransaction_importSessionId_idx" ON "CreditTransaction"("importSessionId");

-- AddForeignKey
ALTER TABLE "ImportSession" ADD CONSTRAINT "ImportSession_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportSession" ADD CONSTRAINT "ImportSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
