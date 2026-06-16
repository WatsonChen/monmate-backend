CREATE TABLE "EventStaffAssignment" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "EventStaffAssignment_pkey" PRIMARY KEY ("id")
);

INSERT INTO "EventStaffAssignment" ("id", "eventId", "userId", "createdAt")
SELECT
  'esa_' || replace(gen_random_uuid()::text, '-', ''),
  "assignedEventId",
  "id",
  CURRENT_TIMESTAMP
FROM "User"
WHERE "role" = 'STAFF'
  AND "assignedEventId" IS NOT NULL
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX "EventStaffAssignment_eventId_userId_key" ON "EventStaffAssignment"("eventId", "userId");
CREATE INDEX "EventStaffAssignment_userId_idx" ON "EventStaffAssignment"("userId");

ALTER TABLE "EventStaffAssignment"
  ADD CONSTRAINT "EventStaffAssignment_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "EventStaffAssignment"
  ADD CONSTRAINT "EventStaffAssignment_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
