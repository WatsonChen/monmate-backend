-- AlterTable: add assignedEventId to User for STAFF role
ALTER TABLE "User" ADD COLUMN "assignedEventId" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_assignedEventId_fkey"
  FOREIGN KEY ("assignedEventId") REFERENCES "Event"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
