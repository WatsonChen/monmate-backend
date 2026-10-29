-- AlterTable
ALTER TABLE "Attendee" ADD COLUMN     "registrationKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Attendee_eventId_registrationKey_key" ON "Attendee"("eventId", "registrationKey");
