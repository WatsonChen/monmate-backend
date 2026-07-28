-- Add FEATURE_UNLOCK reason for per-event premium-feature unlock purchases
ALTER TYPE "CreditTransactionReason" ADD VALUE 'FEATURE_UNLOCK';

-- Track which premium features an event has unlocked (e.g. "BRANDING")
ALTER TABLE "Event" ADD COLUMN "unlockedFeatures" TEXT[] NOT NULL DEFAULT '{}';
