-- AlterTable
ALTER TABLE "Event" ADD COLUMN "allowOverCapacity" BOOLEAN NOT NULL DEFAULT false;

-- 既有活動維持原本「不受人數上限限制」的行為，全部設為允許超額；
-- 之後新建的活動才套用 schema 預設（false＝不能超額）。
UPDATE "Event" SET "allowOverCapacity" = true;
