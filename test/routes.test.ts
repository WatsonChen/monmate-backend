import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { balanceOf, createEvent, createOwner, resetDb } from "./helpers.js";

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

function tokenFor(user: { id: string; email: string; role: string }, assignedEventId?: string) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role, assignedEventId }, process.env.JWT_SECRET!);
}

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON（如匯出檔）*/
  }
  return { status: res.status, json };
}

async function createStaff(eventId: string, assigned = true) {
  const staff = await prisma.user.create({
    data: { name: "staff", email: `s-${Math.random().toString(16).slice(2)}@test.local`, passwordHash: "x", role: "STAFF" }
  });
  if (assigned) await prisma.eventStaffAssignment.create({ data: { eventId, userId: staff.id } });
  return staff;
}

async function addAttendee(eventId: string, capacity = 1) {
  return prisma.attendee.create({
    data: { eventId, name: "王小明", phone: "0911000111", checkInCode: "ABCDE", qrToken: "tok-" + Math.random(), checkInCapacity: capacity }
  });
}

describe("活動權限：他人的活動一律不能碰", () => {
  it("未登入回 401", async () => {
    const a = await createOwner(10);
    const event = await createEvent(a.id);
    expect((await call("GET", `/events/${event.id}`)).status).toBe(401);
    expect((await call("DELETE", `/events/${event.id}`)).status).toBe(401);
  });

  it("另一位主辦對他人活動：讀、改、刪、解鎖、分析、名單、匯出、新增、工作人員、問卷、通知全部 404，且資料與點數不變", async () => {
    const a = await createOwner(10);
    const b = await createOwner(100);
    const event = await createEvent(a.id);
    await addAttendee(event.id);
    const tb = tokenFor(b);
    const id = event.id;

    const attempts: [string, string, unknown?][] = [
      ["GET", `/events/${id}`],
      ["PATCH", `/events/${id}`, { name: "被改掉" }],
      ["DELETE", `/events/${id}`],
      ["POST", `/events/${id}/unlock-feature`, { feature: "BRANDING" }],
      ["GET", `/events/${id}/analytics`],
      ["GET", `/events/${id}/venue-qr`],
      ["POST", `/events/${id}/invite`, { template: "without-registration" }],
      ["GET", `/events/${id}/staff`],
      ["POST", `/events/${id}/staff`, { name: "x", email: "x@test.local", password: "123456" }],
      ["GET", `/events/${id}/attendees`],
      ["GET", `/events/${id}/attendees/export`],
      ["POST", `/events/${id}/attendees`, { name: "灌水", phone: "0900000000" }],
      ["GET", `/events/${id}/survey`],
      ["POST", `/events/${id}/notifications/pre-event`, { content: "x" }],
      ["POST", `/events/${id}/check-in/phone`, { phone: "0911000111" }]
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(method, path, tb, body);
      expect([404, 403], `${method} ${path} 應被拒絕，實際 ${res.status}`).toContain(res.status);
    }

    const after = await prisma.event.findUniqueOrThrow({ where: { id } });
    expect(after.name).toBe("測試活動");
    expect(after.unlockedFeatures).toEqual([]);
    expect(await prisma.attendee.count({ where: { eventId: id } })).toBe(1);
    expect(await balanceOf(b.id)).toBe(100);
    expect(await balanceOf(a.id)).toBe(10);
  });

  it("活動擁有者可以讀與改自己的活動", async () => {
    const a = await createOwner(10);
    const event = await createEvent(a.id);
    const ta = tokenFor(a);
    expect((await call("GET", `/events/${event.id}`, ta)).status).toBe(200);
    expect((await call("PATCH", `/events/${event.id}`, ta, { name: "新名稱" })).status).toBe(200);
  });
});

describe("工作人員權限", () => {
  it("被指派的工作人員可讀活動、看名單、改備註，也能報到", async () => {
    const a = await createOwner(10);
    const event = await createEvent(a.id);
    const attendee = await addAttendee(event.id);
    const staff = await createStaff(event.id);
    const ts = tokenFor(staff);

    expect((await call("GET", `/events/${event.id}`, ts)).status).toBe(200);
    expect((await call("GET", `/events/${event.id}/attendees`, ts)).status).toBe(200);
    expect((await call("PATCH", `/events/${event.id}/attendees/${attendee.id}`, ts, { note: "VIP" })).status).toBe(200);
    expect((await call("POST", `/events/${event.id}/check-in/phone`, ts, { phone: "0911000111" })).status).toBe(200);
  });

  it("工作人員不能改人數、報到狀態，也不能刪活動、匯出名單、新增報名者、管理工作人員", async () => {
    const a = await createOwner(10);
    const event = await createEvent(a.id);
    const attendee = await addAttendee(event.id);
    const staff = await createStaff(event.id);
    const ts = tokenFor(staff);

    expect((await call("PATCH", `/events/${event.id}/attendees/${attendee.id}`, ts, { checkInCapacity: 50 })).status).toBe(403);
    expect((await call("PATCH", `/events/${event.id}/attendees/${attendee.id}`, ts, { checkInStatus: "CHECKED_IN" })).status).toBe(403);
    expect((await call("DELETE", `/events/${event.id}`, ts)).status).toBe(404);
    expect((await call("GET", `/events/${event.id}/attendees/export`, ts)).status).toBe(404);
    expect((await call("POST", `/events/${event.id}/attendees`, ts, { name: "x", phone: "0900" })).status).toBe(404);
    expect((await call("GET", `/events/${event.id}/staff`, ts)).status).toBe(404);

    const after = await prisma.attendee.findUniqueOrThrow({ where: { id: attendee.id } });
    expect(after.checkInCapacity).toBe(1);
    expect(await balanceOf(a.id)).toBe(10);
  });

  it("未被指派的工作人員不能碰這場活動，也不能報到", async () => {
    const a = await createOwner(10);
    const event = await createEvent(a.id);
    const other = await createEvent(a.id);
    await addAttendee(event.id);
    const staff = await createStaff(other.id); // 只被指派到另一場
    const ts = tokenFor(staff, other.id);

    expect((await call("GET", `/events/${event.id}`, ts)).status).toBe(404);
    expect((await call("GET", `/events/${event.id}/attendees`, ts)).status).toBe(404);
    expect((await call("POST", `/events/${event.id}/check-in/phone`, ts, { phone: "0911000111" })).status).toBe(404);
  });
});

describe("後台調高人數要扣點", () => {
  it("1 人調高到 4 人：補扣 3 點並寫入帳本；調低不退", async () => {
    const a = await createOwner(10);
    const event = await createEvent(a.id);
    const attendee = await addAttendee(event.id, 1);
    const ta = tokenFor(a);

    const up = await call("PATCH", `/events/${event.id}/attendees/${attendee.id}`, ta, { checkInCapacity: 4 });
    expect(up.status).toBe(200);
    expect(await balanceOf(a.id)).toBe(7);
    const ledger = await prisma.creditTransaction.findMany({ where: { userId: a.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: -3, eventId: event.id, attendeeId: attendee.id });

    const down = await call("PATCH", `/events/${event.id}/attendees/${attendee.id}`, ta, { checkInCapacity: 2 });
    expect(down.status).toBe(200);
    expect(await balanceOf(a.id)).toBe(7);
  });

  it("先新增 1 人再改成 999 人：會超過 -3 下限而被拒絕，人數與點數都不變", async () => {
    const a = await createOwner(0);
    const event = await createEvent(a.id);
    const attendee = await addAttendee(event.id, 1);
    const res = await call("PATCH", `/events/${event.id}/attendees/${attendee.id}`, tokenFor(a), { checkInCapacity: 999 });
    expect(res.status).toBe(402);
    expect(res.json.error.code).toBe("INSUFFICIENT_ATTENDEE_CREDITS");
    expect((await prisma.attendee.findUniqueOrThrow({ where: { id: attendee.id } })).checkInCapacity).toBe(1);
    expect(await balanceOf(a.id)).toBe(0);
  });
});

describe("公開報名：同電話不等於同一人，也不回傳他人憑證", () => {
  const regPath = (slug: string) => `/events/public/${slug}/register`;
  const key = () => `req-${Math.random().toString(36).slice(2)}-${Date.now()}abcdef`;

  it("同電話但姓名不同：視為不同人，各自新增、各扣 1 點，拿到的是自己的憑證", async () => {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const first = await call("POST", regPath(event.slug), undefined, { name: "王小明", phone: "0911222333", requestId: key() });
    const second = await call("POST", regPath(event.slug), undefined, { name: "王大華", phone: "0911222333", requestId: key() });
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.json.data.qrToken).not.toBe(first.json.data.qrToken);
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(2);
    expect(await balanceOf(owner.id)).toBe(8);

    const ticket = await call("GET", `/events/ticket/${event.slug}?token=${second.json.data.qrToken}`);
    expect(ticket.json.data.attendee.name).toBe("王大華");
  });

  it("姓名與電話都相同、但不是同一次送出：回已報名，不回任何憑證，不新增、不扣點", async () => {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const first = await call("POST", regPath(event.slug), undefined, { name: "王小明", phone: "0911222333", requestId: key() });
    const again = await call("POST", regPath(event.slug), undefined, { name: "  王小明 ", phone: "0911-222-333", requestId: key() });
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("ALREADY_REGISTERED");
    expect(JSON.stringify(again.json)).not.toContain(first.json.data.qrToken);
    expect(again.json.data).toBeUndefined();
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(1);
    expect(await balanceOf(owner.id)).toBe(9);
  });

  it("沒有請求識別碼也不會用電話換到別人的憑證", async () => {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const first = await call("POST", regPath(event.slug), undefined, { name: "王小明", phone: "0911222333" });
    const other = await call("POST", regPath(event.slug), undefined, { name: "陌生人", phone: "0911222333" });
    expect(other.json.data.qrToken).not.toBe(first.json.data.qrToken);
  });

  it("同一次送出重試（同請求識別碼）：回同一個憑證，只有一筆、只扣一次；名額已滿時重試仍成功", async () => {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id, { attendeeLimit: 1 });
    const id = key();
    const first = await call("POST", regPath(event.slug), undefined, { name: "王小明", phone: "0911222333", requestId: id });
    const retry = await call("POST", regPath(event.slug), undefined, { name: "王小明", phone: "0911222333", requestId: id });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.json.data.qrToken).toBe(first.json.data.qrToken);
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(1);
    expect(await balanceOf(owner.id)).toBe(9);
  });

  it("同請求識別碼但姓名不同：不會拿到先前那位的憑證", async () => {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const id = key();
    const first = await call("POST", regPath(event.slug), undefined, { name: "王小明", phone: "0911222333", requestId: id });
    const other = await call("POST", regPath(event.slug), undefined, { name: "李四", phone: "0911222333", requestId: id });
    expect(other.json.data.qrToken).not.toBe(first.json.data.qrToken);
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(2);
  });

  it("並行：同請求識別碼 5 次、或同姓名電話不同識別碼 5 次，都只新增一筆、只扣一點", async () => {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const id = key();
    await Promise.all(
      Array.from({ length: 5 }, () => call("POST", regPath(event.slug), undefined, { name: "甲", phone: "0911000001", requestId: id }))
    );
    expect(await prisma.attendee.count({ where: { eventId: event.id, phone: "0911000001" } })).toBe(1);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => call("POST", regPath(event.slug), undefined, { name: "乙", phone: "0911000002", requestId: key() }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(await prisma.attendee.count({ where: { eventId: event.id, phone: "0911000002" } })).toBe(1);
    expect(await balanceOf(owner.id)).toBe(8);
  });
});

describe("自助報到與同電話報到：不外洩他人資料、不亂挑人", () => {
  async function setup() {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const one = await prisma.attendee.create({
      data: {
        eventId: event.id, name: "王小明", phone: "0911000111", checkInCode: "AAAAA", qrToken: "t1",
        note: "內部備註：VIP", customFields: { 部門: "機密" }, checkInCapacity: 2
      }
    });
    return { owner, event, one };
  }

  it("自助報到回應不含電話、備註、自訂欄位、內部 ID，姓名只顯示遮罩", async () => {
    const { event } = await setup();
    const res = await call("POST", `/events/${event.id}/check-in/self`, undefined, { phone: "0911000111", venueCode: event.venueCode });
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.json);
    expect(text).not.toContain("0911000111");
    expect(text).not.toContain("VIP");
    expect(text).not.toContain("機密");
    expect(text).not.toContain("王小明");
    expect(res.json.data.attendee.name).toBe("王○明");
    expect(res.json.data.attendee).not.toHaveProperty("id");
  });

  it("同電話對應多人：自助報到拒絕且不揭露任何人的姓名；工作人員端列出候選人與報到碼", async () => {
    const { owner, event } = await setup();
    await prisma.attendee.create({
      data: { eventId: event.id, name: "王大華", phone: "0911000111", checkInCode: "BBBBB", qrToken: "t2" }
    });

    const self = await call("POST", `/events/${event.id}/check-in/self`, undefined, { phone: "0911000111", venueCode: event.venueCode });
    expect(self.status).toBe(409);
    expect(self.json.error.code).toBe("PHONE_NOT_UNIQUE");
    expect(JSON.stringify(self.json)).not.toMatch(/王小明|王大華|AAAAA|BBBBB/);

    const staff = await call("POST", `/events/${event.id}/check-in/phone`, tokenFor(owner), { phone: "0911000111" });
    expect(staff.status).toBe(409);
    expect(staff.json.error.message).toContain("王小明（AAAAA）");
    expect(staff.json.error.message).toContain("王大華（BBBBB）");
    // 沒有任何人被誤報到
    const counts = await prisma.attendee.findMany({ where: { eventId: event.id }, select: { checkInCount: true } });
    expect(counts.every((a) => a.checkInCount === 0)).toBe(true);
  });
});

describe("角色", () => {
  it("token 內含未知角色：一律拒絕，即使簽章正確", async () => {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const weird = jwt.sign({ sub: owner.id, email: owner.email, role: "SUPERADMIN" }, process.env.JWT_SECRET!);
    expect((await call("GET", `/events/${event.id}`, weird)).status).toBe(401);
    expect((await call("DELETE", `/events/${event.id}`, weird)).status).toBe(401);
    expect(await prisma.event.count({ where: { id: event.id } })).toBe(1);
  });

  it("OWNER 與 ADMIN 一樣只能操作自己建立的活動，沒有跨活動權限", async () => {
    const a = await createOwner(10);
    const event = await createEvent(a.id);
    const platformOwner = await prisma.user.create({
      data: { name: "owner", email: "owner@test.local", passwordHash: "x", role: "OWNER" }
    });
    const res = await call("GET", `/events/${event.id}`, tokenFor(platformOwner));
    expect(res.status).toBe(404);
    expect((await call("DELETE", `/events/${event.id}`, tokenFor(platformOwner))).status).toBe(404);
  });
});

describe("取消匯入預覽（HTTP）", () => {
  it("未登入 401；他人 404 且預覽仍在；擁有者 200 並刪除", async () => {
    const owner = await createOwner(100);
    const other = await createOwner(100);
    const event = await createEvent(owner.id);
    const session = await prisma.importSession.create({
      data: {
        eventId: event.id, userId: owner.id, fileName: "x.xlsx", fileHash: "h", rows: [], rowErrors: [],
        expiresAt: new Date(Date.now() + 3600_000)
      }
    });
    const path = `/events/${event.id}/attendees/import/${session.id}`;
    expect((await call("DELETE", path)).status).toBe(401);
    expect((await call("DELETE", path, tokenFor(other))).status).toBe(404);
    expect(await prisma.importSession.count({ where: { id: session.id } })).toBe(1);
    const res = await call("DELETE", path, tokenFor(owner));
    expect(res.status).toBe(200);
    expect(res.json.data.discarded).toBe(true);
    expect(await prisma.importSession.count({ where: { id: session.id } })).toBe(0);
  });
});
