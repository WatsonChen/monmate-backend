import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// 只模擬「向 Google 驗證 ID token」這一步；找帳號、建立帳號、發 token 都是真實程式 + 真實測試資料庫
const googlePayloads: Record<string, Record<string, unknown>> = {};
vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    async verifyIdToken({ idToken }: { idToken: string }) {
      const payload = googlePayloads[idToken];
      if (!payload) throw new Error("invalid token");
      return { getPayload: () => payload };
    }
  }
}));

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
beforeEach(async () => {
  await resetDb();
  for (const k of Object.keys(googlePayloads)) delete googlePayloads[k];
});

const addStaffViaApi = async (ownerId: string, ownerEmail: string, eventId: string, email: string) => {
  const token = jwt.sign({ sub: ownerId, email: ownerEmail, role: "ADMIN" }, process.env.JWT_SECRET!);
  const res = await fetch(`${base}/events/${eventId}/staff`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "小幫手", email, password: "123456" })
  });
  return { status: res.status, json: (await res.json()) as any };
};

describe("工作人員 Email 與 Google 登入的綁定", () => {
  it("主辦方設定 123@gmail.com 為工作人員後，本人用 Google 登入會進入同一個工作人員帳號，不會多出新帳號", async () => {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const added = await addStaffViaApi(owner.id, owner.email, event.id, "123@gmail.com");
    expect(added.status).toBe(201);
    const staffId = added.json.data.id;

    googlePayloads.tok = { email: "123@gmail.com", email_verified: true, name: "真人" };
    const result = await authService.googleLogin("tok");
    expect(result.user.id).toBe(staffId);
    expect(result.user.role).toBe("STAFF");
    expect(await prisma.user.count({ where: { email: { equals: "123@gmail.com", mode: "insensitive" } } })).toBe(1);

    const me = await authService.me(staffId);
    expect(me.assignedEventIds).toEqual([event.id]);
  });

  it("主辦方輸入大小寫不同的 Email（Staff@Gmail.com），仍會綁定到同一人，不會另外建立主辦帳號", async () => {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const added = await addStaffViaApi(owner.id, owner.email, event.id, "  Staff@Gmail.com ");
    expect(added.json.data.email).toBe("staff@gmail.com");

    googlePayloads.tok = { email: "staff@gmail.com", email_verified: true };
    const result = await authService.googleLogin("tok");
    expect(result.user.id).toBe(added.json.data.id);
    expect(result.user.role).toBe("STAFF");
  });

  it("舊資料就算是大寫存放的 Email，Google 登入也能比對到", async () => {
    const legacy = await prisma.user.create({ data: { name: "舊工作人員", email: "Old.Staff@Gmail.com", passwordHash: "x", role: "STAFF" } });
    googlePayloads.tok = { email: "old.staff@gmail.com", email_verified: true };
    expect((await authService.googleLogin("tok")).user.id).toBe(legacy.id);
  });

  it("同一個 Email 不同大小寫，不能再被新增成第二個工作人員帳號", async () => {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    await addStaffViaApi(owner.id, owner.email, event.id, "dup@gmail.com");
    const again = await addStaffViaApi(owner.id, owner.email, event.id, "DUP@gmail.com");
    expect(again.status).toBe(409);
    expect(await prisma.user.count({ where: { email: { equals: "dup@gmail.com", mode: "insensitive" } } })).toBe(1);
  });

  it("Google 回傳的 Email 尚未驗證：拒絕登入，也不建立帳號、不登入既有的工作人員帳號", async () => {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    await addStaffViaApi(owner.id, owner.email, event.id, "victim@gmail.com");

    googlePayloads.tok = { email: "victim@gmail.com", email_verified: false };
    await expect(authService.googleLogin("tok")).rejects.toMatchObject({ statusCode: 401, code: "GOOGLE_EMAIL_UNVERIFIED" });
    googlePayloads.tok2 = { email: "nobody@gmail.com" }; // 缺少 email_verified 欄位也視為未驗證
    await expect(authService.googleLogin("tok2")).rejects.toMatchObject({ code: "GOOGLE_EMAIL_UNVERIFIED" });
    expect(await prisma.user.count({ where: { email: "nobody@gmail.com" } })).toBe(0);
  });

  it("全新的 Google 帳號第一次登入：自動建立主辦帳號（Email 轉小寫）", async () => {
    googlePayloads.tok = { email: "New.Organizer@Gmail.com", email_verified: true, name: "新主辦" };
    const result = await authService.googleLogin("tok");
    expect(result.user.role).toBe("ADMIN");
    expect(result.user.email).toBe("new.organizer@gmail.com");
    expect(result.user.attendeeCredits).toBe(0);
  });

  it("已經是主辦的人也可以被指派為別場活動的工作人員（不需要密碼、不會改動原本的帳號）", async () => {
    const owner = await createOwner(10);
    const other = await prisma.user.create({
      data: { name: "另一位主辦", email: "organizer2@gmail.com", passwordHash: "keep-me", role: "ADMIN" }
    });
    const event = await createEvent(owner.id);
    const res = await addStaffViaApi(owner.id, owner.email, event.id, "ORGANIZER2@gmail.com");
    expect(res.status).toBe(201);
    expect(res.json.data.id).toBe(other.id);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
    expect(after.role).toBe("ADMIN");
    expect(after.passwordHash).toBe("keep-me");
  });
});
