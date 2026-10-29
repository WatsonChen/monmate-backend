import { CREDIT_FLOOR } from "@monmate/types";
import type { CreditTransactionReason, Prisma } from "@prisma/client";
import { AppError } from "../lib/http.js";

export type WalletChargeInput = {
  userId: string;
  amount: number;
  reason: CreditTransactionReason;
  eventId?: string;
  attendeeId?: string;
  importSessionId?: string;
  note?: string;
};

// 以單一條件更新扣點：扣完後餘額 >= CREDIT_FLOOR 才成功。
// 同一錢包的並行扣點會在這一列上序列化，因此不可能同時越過底線。
// 必須在呼叫端的 transaction 內使用，讓扣點、帳本與名單變更一起成功或一起回滾。
export async function chargeWallet(tx: Prisma.TransactionClient, input: WalletChargeInput) {
  const { userId, amount } = input;
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError(400, "INVALID_CHARGE", "扣點數必須為正整數");
  }

  const charged = await tx.user.updateMany({
    where: { id: userId, attendeeCredits: { gte: amount + CREDIT_FLOOR } },
    data: { attendeeCredits: { decrement: amount } }
  });

  if (charged.count === 0) {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { attendeeCredits: true } });
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "找不到使用者");
    throw new AppError(
      402,
      "INSUFFICIENT_ATTENDEE_CREDITS",
      `點數不足：本次需 ${amount} 點，目前餘額 ${user.attendeeCredits} 點，操作後將低於可用下限 ${CREDIT_FLOOR} 點，請先儲值。`,
      {
        required: amount,
        balance: user.attendeeCredits,
        balanceAfter: user.attendeeCredits - amount,
        floor: CREDIT_FLOOR
      }
    );
  }

  const { attendeeCredits: balanceAfter } = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { attendeeCredits: true }
  });
  await tx.creditTransaction.create({
    data: {
      userId,
      amount: -amount,
      reason: input.reason,
      balanceAfter,
      eventId: input.eventId,
      attendeeId: input.attendeeId,
      importSessionId: input.importSessionId,
      note: input.note
    }
  });
  return { balanceAfter };
}
