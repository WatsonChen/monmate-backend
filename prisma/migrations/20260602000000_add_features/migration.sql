-- Add new enum values
ALTER TYPE "PaymentProduct" ADD VALUE IF NOT EXISTS 'ATTENDEE_CREDIT';
CREATE TYPE "Gender" AS ENUM ('M', 'F', 'OTHER');

-- User: rename eventCredits -> attendeeCredits
ALTER TABLE "User" RENAME COLUMN "eventCredits" TO "attendeeCredits";

-- Event: drop payment relation, add new fields
ALTER TABLE "Event" DROP CONSTRAINT IF EXISTS "Event_paymentId_key";
ALTER TABLE "Event" DROP COLUMN IF EXISTS "paymentId";
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "content" TEXT;
ALTER TABLE "Event" ADD COLUMN IF NOT EXISTS "registrationRequired" BOOLEAN NOT NULL DEFAULT false;

-- Attendee: add demographics and contact fields
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "age" INTEGER;
ALTER TABLE "Attendee" ADD COLUMN IF NOT EXISTS "gender" "Gender";

-- Survey tables
CREATE TABLE IF NOT EXISTS "Survey" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "title" TEXT NOT NULL DEFAULT '活動問卷',
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Survey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Survey_eventId_key" ON "Survey"("eventId");
ALTER TABLE "Survey" ADD CONSTRAINT "Survey_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS "SurveyQuestion" (
  "id" TEXT NOT NULL,
  "surveyId" TEXT NOT NULL,
  "question" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'text',
  "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "SurveyQuestion_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "SurveyQuestion" ADD CONSTRAINT "SurveyQuestion_surveyId_fkey"
  FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS "SurveyResponse" (
  "id" TEXT NOT NULL,
  "surveyId" TEXT NOT NULL,
  "attendeeId" TEXT,
  "answers" JSONB NOT NULL DEFAULT '{}',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SurveyResponse_surveyId_idx" ON "SurveyResponse"("surveyId");
CREATE INDEX IF NOT EXISTS "SurveyResponse_attendeeId_idx" ON "SurveyResponse"("attendeeId");
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_surveyId_fkey"
  FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE;
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_attendeeId_fkey"
  FOREIGN KEY ("attendeeId") REFERENCES "Attendee"("id") ON DELETE SET NULL;
