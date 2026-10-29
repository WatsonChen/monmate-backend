import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getClientIp } from "../src/lib/client-ip.js";
import { prisma } from "../src/lib/prisma.js";
import { emailService } from "../src/services/email.service.js";
import { purgeExpiredCounters } from "../src/services/rate-limit.service.js";
import { balanceOf, createEvent, createOwner, resetDb } from "./helpers.js";

let server: Server;
let base = "";
const realFetch = globalThis.fetch;

const ENV_KEYS = [
  "TRUSTED_IP_HEADER",
  "TURNSTILE_SECRET_KEY",
  "ABUSE_LIMIT_EVENT_PER_MIN",
  "ABUSE_LIMIT_PHONE_PER_MIN",
  "ABUSE_LIMIT_IP_PER_MIN",
  "ABUSE_LIMIT_CAPTCHA_FAIL_PER_10MIN",
  "ABUSE_ALERT_EVENT_PER_5MIN",
  "ABUSE_ALERT_IP_PER_10MIN",
  "ABUSE_ALERT_COOLDOWN_SECONDS"
];

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
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await realFetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body ? { "content-type": "application/json" } : {}),
      ...opts.headers
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
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

const tokenFor = (u: { id: string; email: string; role: string }) =>
  jwt.sign({ sub: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET!);
const reg = (slug: string, name: string, phone: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  call("POST", `/events/public/${slug}/register`, { body: { name, phone, ...extra }, headers });
const uniquePhone = (i: number) => `09${String(10000000 + i)}`;

describe("來源 IP：只信任明確設定的單一標頭", () => {
  it("未設定可信標頭：一律取不到 IP（不把代理位址當成使用者）", () => {
    expect(getClientIp({ headers: { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" } })).toBeNull();
  });

  it("只讀設定的那個標頭，其他標頭（含偽造的 x-forwarded-for）一律忽略", () => {
    process.env.TRUSTED_IP_HEADER = "x-real-ip";
    expect(getClientIp({ headers: { "x-real-ip": "5.6.7.8", "x-forwarded-for": "9.9.9.9" } })).toBe("5.6.7.8");
    expect(getClientIp({ headers: { "x-forwarded-for": "9.9.9.9" } })).toBeNull();
  });

  it("值含逗號（多層串接）、不是合法 IP、或標頭重複：視為取不到", () => {
    process.env.TRUSTED_IP_HEADER = "x-real-ip";
    expect(getClientIp({ headers: { "x-real-ip": "1.1.1.1, 2.2.2.2" } })).toBeNull();
    expect(getClientIp({ headers: { "x-real-ip": "not-an-ip" } })).toBeNull();
    expect(getClientIp({ headers: { "x-real-ip": ["1.1.1.1", "2.2.2.2"] } })).toBeNull();
  });
});

describe("速率限制：總請求、同電話、同來源分開計算", () => {
  it("同活動同電話 1 分鐘內超過 5 次：第 6 次回 429，不新增、不多扣", async () => {
    const owner = await createOwner(20);
    const event = await createEvent(owner.id);
    const results = [];
    for (let i = 0; i < 6; i++) results.push(await reg(event.slug, `人${i}`, "0911000000"));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 429]);
    expect(results[5].json.error.code).toBe("RATE_LIMITED");
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(5);
    expect(await balanceOf(owner.id)).toBe(15);
  });

  it("另一支電話不受影響", async () => {
    const owner = await createOwner(20);
    const event = await createEvent(owner.id);
    for (let i = 0; i < 6; i++) await reg(event.slug, `人${i}`, "0911000000");
    expect((await reg(event.slug, "別人", "0922000000")).status).toBe(201);
  });

  it("活動總請求超過上限：回 429；其他活動不受影響", async () => {
    process.env.ABUSE_LIMIT_EVENT_PER_MIN = "3";
    const owner = await createOwner(20);
    const a = await createEvent(owner.id);
    const b = await createEvent(owner.id);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await reg(a.slug, `人${i}`, uniquePhone(i))).status);
    expect(statuses).toEqual([201, 201, 201, 429]);
    expect((await reg(b.slug, "他場", uniquePhone(50))).status).toBe(201);
  });

  it("共用 NAT：同一個來源 IP 的 20 位一般使用者（遠低於上限）全部通過", async () => {
    process.env.TRUSTED_IP_HEADER = "x-real-ip";
    const owner = await createOwner(50);
    const event = await createEvent(owner.id);
    const results = [];
    for (let i = 0; i < 20; i++) results.push((await reg(event.slug, `人${i}`, uniquePhone(i), {}, { "x-real-ip": "203.0.113.7" })).status);
    expect(results.every((s) => s === 201)).toBe(true);
  });

  it("來源 IP 超過上限：該 IP 被限流，另一個 IP 不受影響", async () => {
    process.env.TRUSTED_IP_HEADER = "x-real-ip";
    process.env.ABUSE_LIMIT_IP_PER_MIN = "5";
    const owner = await createOwner(50);
    const event = await createEvent(owner.id);
    const from = (ip: string, i: number) => reg(event.slug, `人${i}`, uniquePhone(i), {}, { "x-real-ip": ip });
    const first = [];
    for (let i = 0; i < 6; i++) first.push((await from("203.0.113.7", i)).status);
    expect(first).toEqual([201, 201, 201, 201, 201, 429]);
    expect((await from("198.51.100.9", 99)).status).toBe(201);
  });

  it("偽造 x-forwarded-for 換 IP 也繞不過：計數仍算在可信標頭的 IP 上", async () => {
    process.env.TRUSTED_IP_HEADER = "x-real-ip";
    process.env.ABUSE_LIMIT_IP_PER_MIN = "3";
    const owner = await createOwner(50);
    const event = await createEvent(owner.id);
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await reg(event.slug, `人${i}`, uniquePhone(i), {}, { "x-real-ip": "203.0.113.7", "x-forwarded-for": `10.0.0.${i}` })).status);
    }
    expect(statuses).toEqual([201, 201, 201, 429]);
  });

  it("未設定可信標頭時不做 IP 限制（不會把全部使用者當成同一個來源）", async () => {
    process.env.ABUSE_LIMIT_IP_PER_MIN = "2";
    const owner = await createOwner(50);
    const event = await createEvent(owner.id);
    const results = [];
    for (let i = 0; i < 6; i++) results.push((await reg(event.slug, `人${i}`, uniquePhone(i))).status);
    expect(results.every((s) => s === 201)).toBe(true);
  });

  it("過期的計數可被清理，且可重複執行", async () => {
    await prisma.rateLimitCounter.create({ data: { key: "old", windowStart: new Date(Date.now() - 3600_000), count: 3, expiresAt: new Date(Date.now() - 1800_000) } });
    await prisma.rateLimitCounter.create({ data: { key: "live", windowStart: new Date(), count: 1, expiresAt: new Date(Date.now() + 60_000) } });
    expect(await purgeExpiredCounters()).toBe(1);
    expect(await purgeExpiredCounters()).toBe(0);
    expect(await prisma.rateLimitCounter.count({ where: { key: "live" } })).toBe(1);
  });
});

describe("異常告警：去重與冷卻，不影響報名", () => {
  it("活動內短時間新增達門檻：記錄一筆、寄一封信給主辦；之後繼續新增不再重複寄", async () => {
    process.env.ABUSE_ALERT_EVENT_PER_5MIN = "3";
    const send = vi.spyOn(emailService, "sendAbuseAlert").mockResolvedValue({ success: true, message: "ok" });
    const owner = await createOwner(50);
    const event = await createEvent(owner.id);
    for (let i = 0; i < 6; i++) expect((await reg(event.slug, `人${i}`, uniquePhone(i))).status).toBe(201);

    const alerts = await prisma.abuseEvent.findMany({ where: { eventId: event.id, type: "RATE_ALERT_EVENT" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].notified).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ to: owner.email, kind: "EVENT", count: 3 });
    expect(JSON.stringify(send.mock.calls[0][0])).not.toMatch(/人0|0910000/);
  });

  it("同一活動的來源 IP 告警在冷卻期內只留紀錄、不再寄信", async () => {
    process.env.TRUSTED_IP_HEADER = "x-real-ip";
    process.env.ABUSE_ALERT_EVENT_PER_5MIN = "3";
    process.env.ABUSE_ALERT_IP_PER_10MIN = "3";
    const send = vi.spyOn(emailService, "sendAbuseAlert").mockResolvedValue({ success: true, message: "ok" });
    const owner = await createOwner(50);
    const event = await createEvent(owner.id);
    for (let i = 0; i < 4; i++) await reg(event.slug, `人${i}`, uniquePhone(i), {}, { "x-real-ip": "203.0.113.7" });

    const types = (await prisma.abuseEvent.findMany({ where: { eventId: event.id } })).map((a) => a.type).sort();
    expect(types).toEqual(["RATE_ALERT_EVENT", "RATE_ALERT_IP"]);
    expect(send).toHaveBeenCalledTimes(1);
    const ipRow = await prisma.abuseEvent.findFirstOrThrow({ where: { eventId: event.id, type: "RATE_ALERT_IP" } });
    expect(JSON.stringify(ipRow.detail)).not.toContain("203.0.113.7"); // 只存雜湊，不存原始 IP
  });

  it("冷卻期過後，同一活動再次達門檻會再寄一次", async () => {
    process.env.ABUSE_ALERT_EVENT_PER_5MIN = "2";
    const send = vi.spyOn(emailService, "sendAbuseAlert").mockResolvedValue({ success: true, message: "ok" });
    const owner = await createOwner(50);
    const event = await createEvent(owner.id);
    for (let i = 0; i < 2; i++) await reg(event.slug, `人${i}`, uniquePhone(i));
    expect(send).toHaveBeenCalledTimes(1);

    await prisma.event.update({ where: { id: event.id }, data: { lastAbuseAlertAt: new Date(Date.now() - 3600_000) } });
    await prisma.rateLimitCounter.deleteMany({ where: { key: { startsWith: "reg-ok:evt:" } } });
    for (let i = 2; i < 4; i++) await reg(event.slug, `人${i}`, uniquePhone(i));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("寄信失敗或拋錯：報名照常成功", async () => {
    process.env.ABUSE_ALERT_EVENT_PER_5MIN = "1";
    vi.spyOn(emailService, "sendAbuseAlert").mockRejectedValue(new Error("smtp down"));
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const res = await reg(event.slug, "甲", uniquePhone(1));
    expect(res.status).toBe(201);
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(1);
  });
});

describe("主辦手動暫停／恢復新增報名", () => {
  it("暫停後：新增報名回「暫停」、既有參加者仍可自助與工作人員報到；恢復後可新增", async () => {
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const existing = await reg(event.slug, "王小明", "0911000111");
    expect(existing.status).toBe(201);

    const pause = await call("POST", `/events/${event.id}/public-registration/pause`, { token: tokenFor(owner) });
    expect(pause.status).toBe(200);
    expect(pause.json.data.registrationPausedAt).not.toBeNull();

    const blocked = await reg(event.slug, "新來的", "0922000222");
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe("REGISTRATION_PAUSED");
    expect(JSON.stringify(blocked.json)).not.toMatch(/點|balance|餘額/);
    expect(await balanceOf(owner.id)).toBe(9);

    const info = await call("GET", `/events/public/${event.slug}`);
    expect(info.json.data.registrationPaused).toBe(true);

    const self = await call("POST", `/events/${event.id}/check-in/self`, { body: { phone: "0911000111", venueCode: event.venueCode } });
    expect(self.status).toBe(200);
    expect(self.json.data.status).toBe("SUCCESS");
    const staff = await call("POST", `/events/${event.id}/check-in/phone`, { token: tokenFor(owner), body: { phone: "0911000111" } });
    expect(staff.status).toBe(200);

    const resume = await call("POST", `/events/${event.id}/public-registration/resume`, { token: tokenFor(owner) });
    expect(resume.json.data.registrationPausedAt).toBeNull();
    expect((await reg(event.slug, "新來的", "0922000222")).status).toBe(201);
  });

  it("稽核紀錄：記錄操作者；重複暫停不產生重複紀錄；只有主辦看得到", async () => {
    const owner = await createOwner(10);
    const other = await createOwner(10);
    const event = await createEvent(owner.id);
    const to = tokenFor(owner);
    await call("POST", `/events/${event.id}/public-registration/pause`, { token: to });
    await call("POST", `/events/${event.id}/public-registration/pause`, { token: to });
    await call("POST", `/events/${event.id}/public-registration/resume`, { token: to });

    const rows = await prisma.abuseEvent.findMany({ where: { eventId: event.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.type)).toEqual(["REGISTRATION_PAUSED", "REGISTRATION_RESUMED"]);
    expect(rows.every((r) => r.actorUserId === owner.id)).toBe(true);

    expect((await call("GET", `/events/${event.id}/abuse-events`, { token: to })).json.data).toHaveLength(2);
    expect((await call("GET", `/events/${event.id}/abuse-events`, { token: tokenFor(other) })).status).toBe(404);
  });

  it("非主辦（含工作人員、未登入）不能暫停或恢復", async () => {
    const owner = await createOwner(10);
    const other = await createOwner(10);
    const event = await createEvent(owner.id);
    expect((await call("POST", `/events/${event.id}/public-registration/pause`)).status).toBe(401);
    expect((await call("POST", `/events/${event.id}/public-registration/pause`, { token: tokenFor(other) })).status).toBe(404);
    expect((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).publicRegistrationPausedAt).toBeNull();
  });
});

describe("Turnstile 後端驗證", () => {
  function mockSiteverify(handler: (params: URLSearchParams, call: number) => Response | Promise<Response>) {
    let n = 0;
    const seen: URLSearchParams[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("challenges.cloudflare.com")) {
        const params = new URLSearchParams(String(init?.body));
        seen.push(params);
        return Promise.resolve(handler(params, ++n));
      }
      return realFetch(input, init);
    });
    return seen;
  }
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("未設定金鑰：功能關閉，不呼叫 Cloudflare", async () => {
    const seen = mockSiteverify(() => json({ success: true }));
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    expect((await reg(event.slug, "甲", uniquePhone(1))).status).toBe(201);
    expect(seen).toHaveLength(0);
  });

  it("缺少 token：400，不新增、不扣點", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    mockSiteverify(() => json({ success: true }));
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const res = await reg(event.slug, "甲", uniquePhone(1));
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("CAPTCHA_REQUIRED");
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(0);
    expect(await balanceOf(owner.id)).toBe(10);
  });

  it("驗證成功：新增並扣點；請求帶上 secret、token、來源 IP 與 idempotency_key", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.TRUSTED_IP_HEADER = "x-real-ip";
    const seen = mockSiteverify(() => json({ success: true }));
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const requestId = "req-0123456789abcdef";
    const res = await reg(event.slug, "甲", uniquePhone(1), { turnstileToken: "tok-1", requestId }, { "x-real-ip": "203.0.113.7" });
    expect(res.status).toBe(201);
    expect(seen[0].get("secret")).toBe("test-secret");
    expect(seen[0].get("response")).toBe("tok-1");
    expect(seen[0].get("remoteip")).toBe("203.0.113.7");
    expect(seen[0].get("idempotency_key")).toBe(requestId);
    expect(await balanceOf(owner.id)).toBe(9);
  });

  it("驗證失敗、token 過期或已被使用：400，不新增、不扣點", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    mockSiteverify((p) => json({ success: false, "error-codes": [p.get("response") === "dup" ? "timeout-or-duplicate" : "invalid-input-response"] }));
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const bad = await reg(event.slug, "甲", uniquePhone(1), { turnstileToken: "bad" });
    const dup = await reg(event.slug, "乙", uniquePhone(2), { turnstileToken: "dup" });
    expect([bad.json.error.code, dup.json.error.code]).toEqual(["CAPTCHA_FAILED", "CAPTCHA_EXPIRED"]);
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(0);
    expect(await balanceOf(owner.id)).toBe(10);
  });

  it("同一個 token 不能重複用於新增第二筆（重放）", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const used = new Set<string>();
    mockSiteverify((p) => {
      const t = p.get("response")!;
      if (used.has(t)) return json({ success: false, "error-codes": ["timeout-or-duplicate"] });
      used.add(t);
      return json({ success: true });
    });
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    expect((await reg(event.slug, "甲", uniquePhone(1), { turnstileToken: "once" })).status).toBe(201);
    const replay = await reg(event.slug, "乙", uniquePhone(2), { turnstileToken: "once" });
    expect(replay.status).toBe(400);
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(1);
  });

  it("Cloudflare 暫時失敗一次：自動重試後成功", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const seen = mockSiteverify((_p, n) => (n === 1 ? json({}, 500) : json({ success: true })));
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    expect((await reg(event.slug, "甲", uniquePhone(1), { turnstileToken: "t" })).status).toBe(201);
    expect(seen).toHaveLength(2);
  });

  it("Cloudflare 持續不可用：fail closed，回 503，不放行、不新增、不扣點", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    mockSiteverify(() => json({}, 500));
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const res = await reg(event.slug, "甲", uniquePhone(1), { turnstileToken: "t" });
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe("CAPTCHA_UNAVAILABLE");
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(0);
    expect(await balanceOf(owner.id)).toBe(10);
  });

  it("驗證失敗也被計數並限流：同一來源超過上限後回 429，且服務不可用不算驗證失敗", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    process.env.TRUSTED_IP_HEADER = "x-real-ip";
    process.env.ABUSE_LIMIT_CAPTCHA_FAIL_PER_10MIN = "3";
    mockSiteverify(() => json({ success: false, "error-codes": ["invalid-input-response"] }));
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await reg(event.slug, `人${i}`, uniquePhone(i), { turnstileToken: "bad" }, { "x-real-ip": "203.0.113.7" })).json.error.code);
    expect(codes).toEqual(["CAPTCHA_FAILED", "CAPTCHA_FAILED", "CAPTCHA_FAILED", "RATE_LIMITED", "RATE_LIMITED"]);
    expect(await balanceOf(owner.id)).toBe(10);
  });

  it("被暫停或限流時不會呼叫 Cloudflare（先擋、省成本）", async () => {
    process.env.TURNSTILE_SECRET_KEY = "test-secret";
    const seen = mockSiteverify(() => json({ success: true }));
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    await call("POST", `/events/${event.id}/public-registration/pause`, { token: tokenFor(owner) });
    expect((await reg(event.slug, "甲", uniquePhone(1), { turnstileToken: "t" })).status).toBe(409);
    expect(seen).toHaveLength(0);
  });
});
