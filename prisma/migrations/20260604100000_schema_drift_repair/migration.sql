-- Schema drift repair: add all columns that may be missing due to migrations
-- being recorded as applied without the SQL actually executing.
-- All statements use IF NOT EXISTS / conditional logic to be fully idempotent.

-- ── User ──────────────────────────────────────────────────────────────────────
-- Rename eventCredits → attendeeCredits if the old name still exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'User' AND column_name = 'eventCredits'
  ) THEN
    ALTER TABLE "User" RENAME COLUMN "eventCredits" TO "attendeeCredits";
  END IF;
END $$;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "attendeeCredits" INTEGER NOT NULL DEFAULT 0;

-- ── Event ─────────────────────────────────────────────────────────────────────
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "description"           TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "content"               TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "endAt"                 TIMESTAMP(3);
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "location"              TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "attendeeLimit"         INTEGER;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "registrationRequired"  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "venueCode"             TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "registrationFields"    JSONB NOT NULL DEFAULT '[]';

-- ── Attendee ──────────────────────────────────────────────────────────────────
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "email"        TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "age"          INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'Attendee' AND column_name = 'gender'
  ) THEN
    ALTER TABLE "Attendee" ADD COLUMN "gender" "Gender";
  END IF;
END $$;

-- ── CheckInLog ────────────────────────────────────────────────────────────────
ALTER TABLE "CheckInLog" ADD COLUMN IF NOT EXISTS "checkedInAt" TIMESTAMP(3);

-- ── Payment ───────────────────────────────────────────────────────────────────
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "pricingTier"    TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "attendeeLimit"  INTEGER;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "checkoutUrl"    TEXT;
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "consumedAt"     TIMESTAMP(3);
ALTER TABLE "Payment" ADD COLUMN IF NOT EXISTS "paidAt"         TIMESTAMP(3);
