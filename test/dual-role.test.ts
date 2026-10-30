import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { authService } from "../src/services/auth.service.js";
import { createEvent, createOwner, resetDb } from "./helpers.js";

let server: Server;
let base = "";
beforeAll(async () => {
  const { app } = await import("../src/app.js");
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});
beforeEach(resetDb);

const tokenFor = (u: { id: string; email: string; role: string }) =>
  jwt.sign({ sub: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET!);

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json };
}

const addAttendee = (eventId: string) =>
  prisma.attendee.create({
    data: { eventId, name: "王小明", phone: "0911000111", checkInCode: "AAAAA", qrToken: "t-" + Math.random(), checkInCapacity: 2 }
  });

describe("同一個帳號：A 活動的工作人員、B 活動的主辦", () => {
  async function setup() {
    const organizerA = await createOwner(10);
    const eventA = await createEvent(organizerA.id);
    const attendeeA = await addAttendee(eventA.id);
    const stranger = await createOwner(10);
    const eventC = await createEvent(stranger.id);

    // P 是一般主辦帳號（ADMIN），有自己的活動 B
    const p = await prisma.user.create({ data: { name: "P", email: "p@gmail.com", passwordHash: "x", role: "ADMIN", attendeeCredits: 20 } });
    const eventB = await createEvent(p.id);
    await addAttendee(eventB.id);

    // A 的主辦把 P 指派為工作人員（P 不需要新密碼）
    const assign = await call("POST", `/events/${eventA.id}/staff`, tokenFor(organizerA), { email: "P@Gmail.com" });
    expect(assign.status).toBe(201);
    return { organizerA, eventA, attendeeA, eventB, eventC, p, tp: tokenFor(p) };
  }

  it("在 A 活動只有工作人員的權限：可報到、查名單、改備註，不能改人數、匯出、刪除、管理工作人員", async () => {
    const { eventA, attendeeA, tp } = await setup();
    expect((await call("GET", `/events/${eventA.id}`, tp)).status).toBe(200);
    expect((await call("GET", `/events/${eventA.id}/attendees`, tp)).status).toBe(200);
    expect((await call("PATCH", `/events/${eventA.id}/attendees/${attendeeA.id}`, tp, { note: "VIP" })).status).toBe(200);
    expect((await call("POST", `/events/${eventA.id}/check-in/phone`, tp, { phone: "0911000111" })).status).toBe(200);

    expect((await call("PATCH", `/events/${eventA.id}/attendees/${attendeeA.id}`, tp, { checkInCapacity: 50 })).status).toBe(403);
    expect((await call("PATCH", `/events/${eventA.id}/attendees/${attendeeA.id}`, tp, { checkInStatus: "NOT_CHECKED_IN" })).status).toBe(403);
    expect((await call("GET", `/events/${eventA.id}/attendees/export`, tp)).status).toBe(404);
    expect((await call("DELETE", `/events/${eventA.id}`, tp)).status).toBe(404);
    expect((await call("POST", `/events/${eventA.id}/unlock-feature`, tp, { feature: "BRANDING" })).status).toBe(404);
    expect((await call("GET", `/events/${eventA.id}/staff`, tp)).status).toBe(404);
    expect((await prisma.attendee.findUniqueOrThrow({ where: { id: attendeeA.id } })).checkInCapacity).toBe(2);
  });

  it("在自己的 B 活動是完整的主辦：可管理名單、匯出、修改設定", async () => {
    const { eventB, tp } = await setup();
    expect((await call("GET", `/events/${eventB.id}`, tp)).status).toBe(200);
    expect((await call("GET", `/events/${eventB.id}/attendees`, tp)).status).toBe(200);
    expect((await call("GET", `/events/${eventB.id}/attendees/export`, tp)).status).toBe(200);
    expect((await call("PATCH", `/events/${eventB.id}`, tp, { name: "改名" })).status).toBe(200);
  });

  it("與自己無關的第三方活動（C）一律看不到", async () => {
    const { eventC, tp } = await setup();
    for (const [m, path] of [["GET", `/events/${eventC.id}`], ["GET", `/events/${eventC.id}/attendees`], ["DELETE", `/events/${eventC.id}`]] as const) {
      expect((await call(m, path, tp)).status, `${m} ${path}`).toBe(404);
    }
  });

  it("/auth/me 同時回傳主辦角色與被指派的活動，前端據此顯示兩種入口", async () => {
    const { p, eventA } = await setup();
    const me = await authService.me(p.id);
    expect(me.role).toBe("ADMIN");
    expect(me.assignedEventIds).toEqual([eventA.id]);
  });

  it("A 的工作人員身分不會動到 P 原本的帳號資料（角色、密碼、點數）", async () => {
    const { p } = await setup();
    const after = await prisma.user.findUniqueOrThrow({ where: { id: p.id } });
    expect(after).toMatchObject({ role: "ADMIN", passwordHash: "x", attendeeCredits: 20 });
  });
});

describe("純工作人員帳號開始自己辦活動", () => {
  it("可以建立自己的活動，帳號升級為主辦，並且能完整使用自己的活動（先前會 403）；原本被指派的活動仍只有工作人員權限", async () => {
    const organizerA = await createOwner(10);
    const eventA = await createEvent(organizerA.id);
    const attendeeA = await addAttendee(eventA.id);
    const assigned = await call("POST", `/events/${eventA.id}/staff`, tokenFor(organizerA), {
      name: "小幫手", email: "helper@gmail.com", password: "123456"
    });
    expect(assigned.status).toBe(201);
    const helper = await prisma.user.findUniqueOrThrow({ where: { email: "helper@gmail.com" } });
    expect(helper.role).toBe("STAFF");
    const th = tokenFor(helper);

    const created = await call("POST", "/events", th, { name: "我自己的活動", startAt: new Date(Date.now() + 86400000).toISOString() });
    expect(created.status).toBe(201);
    const eventB = created.json.data.id as string;

    expect((await prisma.user.findUniqueOrThrow({ where: { id: helper.id } })).role).toBe("ADMIN");
    expect((await call("GET", `/events/${eventB}`, th)).status).toBe(200);
    expect((await call("GET", `/events/${eventB}/attendees`, th)).status).toBe(200);
    expect((await call("GET", `/events/${eventB}/attendees/export`, th)).status).toBe(200);

    expect((await call("GET", `/events/${eventA.id}/attendees/export`, th)).status).toBe(404);
    expect((await call("PATCH", `/events/${eventA.id}/attendees/${attendeeA.id}`, th, { checkInCapacity: 9 })).status).toBe(403);
    expect((await call("PATCH", `/events/${eventA.id}/attendees/${attendeeA.id}`, th, { note: "ok" })).status).toBe(200);
  });
});

describe("新增工作人員的規則", () => {
  async function ctx() {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    return { owner, event, to: tokenFor(owner) };
  }

  it("已經有帳號的 Email：只填 Email 就能指派，空白的姓名與密碼視為沒填", async () => {
    const { event, to } = await ctx();
    const existing = await prisma.user.create({ data: { name: "已有帳號", email: "has@gmail.com", passwordHash: "keep", role: "ADMIN" } });
    const res = await call("POST", `/events/${event.id}/staff`, to, { email: "has@gmail.com", name: "", password: "" });
    expect(res.status).toBe(201);
    expect(res.json.data.id).toBe(existing.id);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: existing.id } })).passwordHash).toBe("keep");
  });

  it("全新的 Email 必須填姓名與至少 6 碼的密碼，否則不建立帳號", async () => {
    const { event, to } = await ctx();
    expect((await call("POST", `/events/${event.id}/staff`, to, { email: "new@gmail.com" })).status).toBe(400);
    expect((await call("POST", `/events/${event.id}/staff`, to, { email: "new@gmail.com", name: "新人", password: "123" })).status).toBe(400);
    expect(await prisma.user.count({ where: { email: "new@gmail.com" } })).toBe(0);
    expect((await call("POST", `/events/${event.id}/staff`, to, { email: "new@gmail.com", name: "新人", password: "123456" })).status).toBe(201);
  });

  it("活動建立者不能被指派成自己活動的工作人員", async () => {
    const { owner, event, to } = await ctx();
    const res = await call("POST", `/events/${event.id}/staff`, to, { email: owner.email });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("STAFF_IS_OWNER");
  });

  it("同一個人不能重複指派到同一場活動", async () => {
    const { event, to } = await ctx();
    await prisma.user.create({ data: { name: "P", email: "dup@gmail.com", passwordHash: "x", role: "ADMIN" } });
    expect((await call("POST", `/events/${event.id}/staff`, to, { email: "dup@gmail.com" })).status).toBe(201);
    expect((await call("POST", `/events/${event.id}/staff`, to, { email: "DUP@gmail.com" })).status).toBe(409);
  });

  it("只有活動建立者能指派；被指派的工作人員不能再去指派別人", async () => {
    const { event, to } = await ctx();
    const helper = await prisma.user.create({ data: { name: "H", email: "h@gmail.com", passwordHash: "x", role: "ADMIN" } });
    await call("POST", `/events/${event.id}/staff`, to, { email: "h@gmail.com" });
    const res = await call("POST", `/events/${event.id}/staff`, tokenFor(helper), { email: "x@gmail.com", name: "X", password: "123456" });
    expect(res.status).toBe(404);
    expect(await prisma.user.count({ where: { email: "x@gmail.com" } })).toBe(0);
  });
});
