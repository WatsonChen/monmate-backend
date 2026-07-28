-- Custom cover banner image for the event's one-page site; falls back to
-- the rotating placeholder set (EventCoverBanner) when not set.
ALTER TABLE "Event" ADD COLUMN "coverImageUrl" TEXT;
