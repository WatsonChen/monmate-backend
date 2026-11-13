import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/lib/prisma.js";
import { emailService } from "../src/services/email.service.js";
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
  vi.restoreAllMocks();
});

const register = async (slug: string, body: Record<string, unknown>) => {
  const res = await fetch(`${base}/events/public/${slug}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, json: (await res.json()) as any };
};

describe("公開報名選填 Email：寄票券連結，方便弄丟時找回", () => {
  it("有填 Email：存下信箱，並寄出帶有該票券連結的信（寄給對方填的信箱）", async () => {
    const send = vi.spyOn(emailService, "send").mockResolvedValue({ success: true, message: "ok" });
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);

    const r = await register(event.slug, { name: "小明", phone: "0912345678", email: " Ming@Example.com " });
    expect(r.status).toBe(201);

    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.to).toBe("Ming@Example.com".toLowerCase());
    expect(mail.ticketUrl).toContain(`/event/${event.slug}/ticket?token=${r.json.data.qrToken}`);
    const saved = await prisma.attendee.findFirstOrThrow({ where: { eventId: event.id } });
    expect(saved.email).toBe("ming@example.com");
  });

  it("沒填 Email：照常報名，不寄信", async () => {
    const send = vi.spyOn(emailService, "send").mockResolvedValue({ success: true, message: "ok" });
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    expect((await register(event.slug, { name: "小華", phone: "0922333444" })).status).toBe(201);
    expect((await register(event.slug, { name: "小美", phone: "0933444555", email: "" })).status).toBe(201);
    expect(send).not.toHaveBeenCalled();
  });

  it("Email 格式錯誤：直接擋下，不建立報名、不扣點", async () => {
    const send = vi.spyOn(emailService, "send").mockResolvedValue({ success: true, message: "ok" });
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const r = await register(event.slug, { name: "小明", phone: "0912345678", email: "not-an-email" });
    expect(r.status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect(await prisma.attendee.count({ where: { eventId: event.id } })).toBe(0);
  });

  it("寄信失敗不影響報名；同一次送出重試（replay）不會重複寄信", async () => {
    const send = vi.spyOn(emailService, "send").mockRejectedValue(new Error("smtp down"));
    const owner = await createOwner(10);
    const event = await createEvent(owner.id);
    const requestId = "req_abcdefghijklmnop1234";
    const first = await register(event.slug, { name: "小明", phone: "0912345678", email: "a@b.co", requestId });
    expect(first.status).toBe(201);
    const retry = await register(event.slug, { name: "小明", phone: "0912345678", email: "a@b.co", requestId });
    expect(retry.status).toBe(200);
    expect(retry.json.data.qrToken).toBe(first.json.data.qrToken);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
