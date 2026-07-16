-- AlterEnum
ALTER TYPE "CreditTransactionReason" ADD VALUE 'MANUAL_ADJUSTMENT';

-- AlterTable
ALTER TABLE "CreditTransaction" ADD COLUMN "note" TEXT;
