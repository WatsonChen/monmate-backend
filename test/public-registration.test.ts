import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { PUBLIC_MAX_CAPACITY, attendeeService } from "../src/services/attendee.service.js";
import { balanceOf, createEvent, createOwner, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
});

async function seedAttendee(eventId: string, capacity = 1) {
  return prisma.attendee.create({
    data: { eventId, name: "來賓", phone: "0911000000", checkInCode: "ABCDE", qrToken: "tok_" + Math.random().toString(36).slice(2), checkInCapacity: capacity }
  });
}

describe("公開報名補完資料（攜伴加人）", () => {
  it("攜伴加人由主辦點數支付，落在 -3 內可完成", async () => {
    const owner = await createOwner(0);
    const event = await createEvent(owner.id);
    const a = await seedAttendee(event.id);
    await attendeeService.completeRegistration(event.id, a.qrToken, { name: "來賓", capacity: 3 });
    expect((await prisma.attendee.findUniqueOrThrow({ where: { id: a.id } })).checkInCapacity).toBe(3);
    expect(await balanceOf(owner.id)).toBe(-2);
  });

  it("會低於 -3：只告訴參加者無法報名，不洩漏主辦餘額或帳務資訊，名單與餘額不變", async () => {
    const owner = await createOwner(-3);
    const event = await createEvent(owner.id);
    const a = await seedAttendee(event.id);
    const err = await attendeeService.completeRegistration(event.id, a.qrToken, { name: "來賓", capacity: 2 }).catch((e) => e);
    expect(err).toMatchObject({ statusCode: 409, code: "REGISTRATION_UNAVAILABLE" });
    expect(err.message).not.toMatch(/\d|點|額度|儲值/);
    expect(err.details).toBeUndefined();
    expect((await prisma.attendee.findUniqueOrThrow({ where: { id: a.id } })).checkInCapacity).toBe(1);
    expect(await balanceOf(owner.id)).toBe(-3);
  });

  it("人數上限已滿時不揭露上限與現有人數", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id, { attendeeLimit: 2, allowOverCapacity: false });
    const a = await seedAttendee(event.id, 2);
    const err = await attendeeService.completeRegistration(event.id, a.qrToken, { name: "來賓", capacity: 3 }).catch((e) => e);
    expect(err).toMatchObject({ code: "CAPACITY_FULL" });
    expect(err.message).not.toMatch(/\d/);
  });

  it("單人人數上限 20，只能調高不能調低重填", async () => {
    const owner = await createOwner(100);
    const event = await createEvent(owner.id);
    const a = await seedAttendee(event.id);
    await attendeeService.completeRegistration(event.id, a.qrToken, { name: "來賓", capacity: 999 });
    expect((await prisma.attendee.findUniqueOrThrow({ where: { id: a.id } })).checkInCapacity).toBe(PUBLIC_MAX_CAPACITY);
    expect(await balanceOf(owner.id)).toBe(100 - (PUBLIC_MAX_CAPACITY - 1));

    await attendeeService.completeRegistration(event.id, a.qrToken, { name: "來賓", capacity: 1 });
    expect((await prisma.attendee.findUniqueOrThrow({ where: { id: a.id } })).checkInCapacity).toBe(PUBLIC_MAX_CAPACITY);
    expect(await balanceOf(owner.id)).toBe(100 - (PUBLIC_MAX_CAPACITY - 1)); // 不會重複扣點
  });
});
