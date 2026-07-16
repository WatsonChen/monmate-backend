-- CreateEnum
CREATE TYPE "CreditTransactionReason" AS ENUM ('PAYMENT_TOPUP', 'ATTENDEE_CREATE', 'ATTENDEE_IMPORT');

-- CreateTable
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "reason" "CreditTransactionReason" NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "eventId" TEXT,
    "attendeeId" TEXT,
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreditTransaction_userId_createdAt_idx" ON "CreditTransaction"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
