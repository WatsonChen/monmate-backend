import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { CREDIT_FLOOR } from "../src/config/credit.js";
import { prisma } from "../src/lib/prisma.js";
import { attendeeService } from "../src/services/attendee.service.js";
import { importService } from "../src/services/import.service.js";
import { chargeWallet } from "../src/services/credit-wallet.service.js";
import { HEADER, balanceOf, createEvent, createOwner, people, previewOf, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
});

describe("錢包 -3 點下限", () => {
  it("下限常數為 -3", () => {
    expect(CREDIT_FLOOR).toBe(-3);
  });

  it("餘額 2 點新增 4 人：完成後 -2，允許", async () => {
    const owner = await createOwner(2);
    const event = await createEvent(owner.id);
    await attendeeService.createSingle(event.id, owner.id, { name: "A", phone: "0911", capacity: 4 });
    expect(await balanceOf(owner.id)).toBe(-2);
  });

  it("餘額 0 點新增 3 人：剛好 -3，允許", async () => {
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    await attendeeService.createSingle(event.id, owner.id, { name: "A", phone: "0911", capacity: 3 });
    expect(await balanceOf(owner.id)).toBe(-3);
  });

  it("餘額 -3 再新增 1 人：拒絕、帶儲值所需資訊，且不留下名單、不扣點、不寫帳本", async () => {
    const owner = await createOwner(-3);
    const event = await createEvent(owner.id);
    await expect(
      attendeeService.createSingle(event.id, owner.id, { name: "A", phone: "0911", capacity: 1 })
    ).rejects.toMatchObject({
      statusCode: 402,
      code: "INSUFFICIENT_ATTENDEE_CREDITS",
      details: { required: 1, balance: -3, balanceAfter: -4, floor: -3 }
    });
    expect(await balanceOf(owner.id)).toBe(-3);
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(0);
    expect(await prisma.creditTransaction.count({ where: { userId: owner.id } })).toBe(0);
  });

  it("餘額 0 匯入 100 位新參加者：整批拒絕，不會先匯入前 3 人", async () => {
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    const preview = await previewOf(event.id, owner.id, [HEADER, ...people(100)]);
    expect(preview.wallet.needsTopUp).toBe(true);
    await expect(
      importService.confirm(event.id, owner.id, preview.sessionId, { expectedCost: preview.billableHeadcount })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ATTENDEE_CREDITS" });
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(0);
    expect(await balanceOf(owner.id)).toBe(0);
  });

  it("並行扣點：餘額 0、10 個同時扣 1 點，恰好 3 個成功，最終 -3", async () => {
    const owner = await createOwner(0);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        prisma.$transaction((tx) => chargeWallet(tx, { userId: owner.id, amount: 1, reason: "ATTENDEE_CREATE" }))
      )
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await balanceOf(owner.id)).toBe(-3);
    expect(await prisma.creditTransaction.count({ where: { userId: owner.id } })).toBe(3);
  });

  it("兩場不同活動並行新增，同一錢包仍不會低於 -3", async () => {
    const owner = await createOwner(0);
    const e1 = await createEvent(owner.id);
    const e2 = await createEvent(owner.id);
    const results = await Promise.allSettled([
      ...[0, 1, 2].map((i) => attendeeService.createSingle(e1.id, owner.id, { name: `a${i}`, phone: `0911${i}`, capacity: 1 })),
      ...[0, 1, 2].map((i) => attendeeService.createSingle(e2.id, owner.id, { name: `b${i}`, phone: `0922${i}`, capacity: 1 }))
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(await balanceOf(owner.id)).toBe(-3);
    const total = await prisma.attendee.count({ where: { eventId: { in: [e1.id, e2.id] } } });
    expect(total).toBe(3);
  });
});
