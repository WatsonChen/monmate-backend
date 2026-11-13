import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { isEventEnded } from "../src/lib/event-time.js";
import { eventService } from "../src/services/event.service.js";
import { prisma } from "../src/lib/prisma.js";
import { createEvent, createOwner, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
});

describe("活動是否已結束", () => {
  it("有結束時間：過了才算結束", () => {
    const e = { startAt: new Date("2026-08-06T06:00:00Z"), endAt: new Date("2026-08-06T08:30:00Z") };
    expect(isEventEnded(e, new Date("2026-08-06T08:29:00Z"))).toBe(false);
    expect(isEventEnded(e, new Date("2026-08-06T08:31:00Z"))).toBe(true);
  });

  it("沒有結束時間：開始當天（台灣時間）過完才算結束", () => {
    // 台灣 8/6 下午 2:00
    const e = { startAt: new Date("2026-08-06T06:00:00Z"), endAt: null };
    expect(isEventEnded(e, new Date("2026-08-06T15:59:00Z"))).toBe(false); // 台灣 8/6 23:59
    expect(isEventEnded(e, new Date("2026-08-06T16:00:00Z"))).toBe(true); // 台灣 8/7 00:00
  });

  it("公開頁與後台資料都帶 isEnded", async () => {
    const owner = await createOwner(10);
    const past = await createEvent(owner.id, { startAt: new Date(Date.now() - 3 * 86400000), endAt: new Date(Date.now() - 2 * 86400000) });
    const future = await createEvent(owner.id);
    expect((await eventService.getPublicBySlug(past.slug)).isEnded).toBe(true);
    expect((await eventService.getPublicBySlug(future.slug)).isEnded).toBe(false);
    expect((await eventService.get(past.id)).isEnded).toBe(true);
  });
});
