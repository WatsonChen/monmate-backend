-- 加上登入憑證版本欄位（既有帳號預設 0，既有登入不受影響）
ALTER TABLE "User" ADD COLUMN "tokenVersion" INTEGER NOT NULL DEFAULT 0;
