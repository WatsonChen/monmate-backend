import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { authService } from "../src/services/auth.service.js";
import { resetDb } from "./helpers.js";

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

const me = (token: string) => fetch(`${base}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
const mkUser = (email = "t@test.local") =>
  prisma.user.create({ data: { name: "t", email, passwordHash: bcrypt.hashSync("pw-123456", 4), role: "ADMIN" } });

describe("登入憑證撤銷（登出所有裝置）", () => {
  it("登入取得的憑證可用；登出所有裝置後，所有舊憑證立刻失效，重新登入的新憑證可用", async () => {
    await mkUser();
    const a = (await authService.login("t@test.local", "pw-123456")).token;
    const b = (await authService.login("t@test.local", "pw-123456")).token; // 另一台裝置
    expect((await me(a)).status).toBe(200);
    expect((await me(b)).status).toBe(200);

    const res = await fetch(`${base}/auth/logout-all`, { method: "POST", headers: { Authorization: `Bearer ${a}` } });
    expect(res.status).toBe(200);

    expect((await me(a)).status).toBe(401);
    expect((await me(b)).status).toBe(401);

    const c = (await authService.login("t@test.local", "pw-123456")).token;
    expect((await me(c)).status).toBe(200);
  });

  it("沒有版本欄位的舊憑證（功能上線前發出的）在未登出前仍然有效，不會讓現有使用者被登出", async () => {
    const u = await mkUser();
    const legacy = jwt.sign({ email: u.email, role: "ADMIN" }, process.env.JWT_SECRET!, { subject: u.id });
    expect((await me(legacy)).status).toBe(200);
    await authService.logoutAll(u.id);
    expect((await me(legacy)).status).toBe(401);
  });

  it("帳號已刪除，憑證立刻失效", async () => {
    const u = await mkUser();
    const t = (await authService.login("t@test.local", "pw-123456")).token;
    await prisma.user.delete({ where: { id: u.id } });
    expect((await me(t)).status).toBe(401);
  });

  it("只影響自己：別人的憑證不受影響；未登入不能呼叫", async () => {
    await mkUser("x@test.local");
    const other = await mkUser("y@test.local");
    const tx = (await authService.login("x@test.local", "pw-123456")).token;
    const ty = (await authService.login("y@test.local", "pw-123456")).token;
    await authService.logoutAll(other.id);
    expect((await me(tx)).status).toBe(200);
    expect((await me(ty)).status).toBe(401);
    expect((await fetch(`${base}/auth/logout-all`, { method: "POST" })).status).toBe(401);
  });

  it("簽章錯誤或被竄改版本號的憑證一律拒絕", async () => {
    const u = await mkUser();
    const forged = jwt.sign({ email: u.email, role: "ADMIN", tv: 0 }, "wrong-secret-wrong-secret-wrong", { subject: u.id });
    expect((await me(forged)).status).toBe(401);
  });
});
