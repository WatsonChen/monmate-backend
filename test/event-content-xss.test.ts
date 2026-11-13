import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { eventService } from "../src/services/event.service.js";
import { createEvent, createOwner, resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
});

const EVIL = '<p>歡迎</p><img src="https://x.test/a.png" onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">連結</a>';
const dangerous = /<script|onerror|javascript:|alert\(/i;

describe("活動說明的 XSS 防護", () => {
  it("建立活動時淨化後才存入資料庫", async () => {
    const owner = await createOwner();
    const created = await eventService.create({ name: "x", content: EVIL, startAt: new Date().toISOString(), createdById: owner.id });
    expect(created.content).not.toMatch(dangerous);
    const row = await prisma.event.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.content).not.toMatch(dangerous);
    expect(row.content).toContain("<p>歡迎</p>");
  });

  it("更新活動時淨化；清空 content 時存 null", async () => {
    const owner = await createOwner();
    const event = await createEvent(owner.id);
    const updated = await eventService.update(event.id, { content: EVIL });
    expect(updated.content).not.toMatch(dangerous);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).content).not.toMatch(dangerous);
    const cleared = await eventService.update(event.id, { content: null });
    expect(cleared.content).toBeNull();
  });

  it("沒帶 content 的更新不會動到既有內容", async () => {
    const owner = await createOwner();
    const event = await createEvent(owner.id, { content: "<p>原本</p>" });
    await eventService.update(event.id, { name: "新名稱" });
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).content).toBe("<p>原本</p>");
  });

  it("舊資料（淨化功能上線前就已存入的惡意內容）在公開與後台輸出時也會被淨化", async () => {
    const owner = await createOwner();
    const event = await createEvent(owner.id, { content: EVIL });
    const pub = await eventService.getPublicBySlug(event.slug);
    expect(pub.content).not.toMatch(dangerous);
    const admin = await eventService.get(event.id);
    expect(admin.content).not.toMatch(dangerous);
  });
});
