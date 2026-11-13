import bcrypt from "bcryptjs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { authService } from "../src/services/auth.service.js";
import { resetDb } from "./helpers.js";

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
});

const mkUser = (email: string, password = "right-password") =>
  prisma.user.create({ data: { name: "u", email, passwordHash: bcrypt.hashSync(password, 4), role: "ADMIN" } });

describe("密碼登入：限流與帳號列舉", () => {
  it("同一個 email 在視窗內超過 10 次嘗試後回 429，連正確密碼也一樣被擋", async () => {
    await mkUser("a@test.local");
    for (let i = 0; i < 10; i++) {
      await expect(authService.login("a@test.local", "wrong")).rejects.toMatchObject({ statusCode: 401 });
    }
    await expect(authService.login("a@test.local", "right-password")).rejects.toMatchObject({ statusCode: 429, code: "RATE_LIMITED" });
  });

  it("不同 email 互不影響；大小寫與前後空白視為同一個 email", async () => {
    await mkUser("b@test.local");
    await mkUser("c@test.local");
    for (let i = 0; i < 10; i++) await authService.login(i % 2 ? "B@Test.local " : "b@test.local", "wrong").catch(() => undefined);
    await expect(authService.login("b@test.local", "right-password")).rejects.toMatchObject({ statusCode: 429 });
    await expect(authService.login("c@test.local", "right-password")).resolves.toMatchObject({ token: expect.any(String) });
  });

  it("正常登入仍可使用", async () => {
    await mkUser("d@test.local");
    await expect(authService.login("d@test.local", "right-password")).resolves.toMatchObject({ user: { email: "d@test.local" } });
  });

  it("不存在的帳號與 Google 帳號（沒有密碼）一律回同樣的 401", async () => {
    await prisma.user.create({ data: { name: "g", email: "g@test.local", passwordHash: "google-oauth", role: "ADMIN" } });
    const ghost = await authService.login("nobody@test.local", "x").catch((e) => e);
    const google = await authService.login("g@test.local", "google-oauth").catch((e) => e);
    expect(ghost).toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
    expect(google).toMatchObject({ statusCode: 401, code: "INVALID_CREDENTIALS" });
    expect(google.message).toBe(ghost.message);
  });
});
