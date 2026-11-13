import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const putCalls: { path: string; type: string }[] = [];
vi.mock("@vercel/blob", () => ({
  put: async (path: string, _buf: Buffer, opts: { contentType: string }) => {
    putCalls.push({ path, type: opts.contentType });
    return { url: `https://blob.test/${path}` };
  }
}));

import { prisma } from "../src/lib/prisma.js";
import { parseImportFile } from "../src/services/import.service.js";
import { createOwner, resetDb, xlsxBuffer } from "./helpers.js";

let server: Server;
let base = "";
let token = "";

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
  putCalls.length = 0;
  const u = await createOwner();
  token = jwt.sign({ email: u.email, role: "ADMIN" }, process.env.JWT_SECRET!, { subject: u.id });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

async function upload(bytes: Buffer, type: string) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type }), "x");
  return fetch(`${base}/uploads/image`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
}

describe("圖片上傳：檢查實際檔案內容", () => {
  it("真的 PNG 可以上傳", async () => {
    const res = await upload(PNG, "image/png");
    expect(res.status).toBe(200);
    expect(putCalls[0].type).toBe("image/png");
  });

  it("謊稱是 PNG 的 HTML／SVG／腳本一律拒絕", async () => {
    for (const body of ["<html><script>alert(1)</script></html>", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>']) {
      const res = await upload(Buffer.from(body), "image/png");
      expect(res.status).toBe(400);
    }
    expect(putCalls).toHaveLength(0);
  });

  it("內容是 PNG 但宣告成 JPEG 也拒絕", async () => {
    expect((await upload(PNG, "image/jpeg")).status).toBe(400);
  });

  it("未登入不能上傳", async () => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(PNG)], { type: "image/png" }), "x");
    expect((await fetch(`${base}/uploads/image`, { method: "POST", body: form })).status).toBe(401);
  });
});

describe("名單匯入：只接受試算表與純文字", () => {
  it("xlsx 與 CSV 可以解析", () => {
    expect(parseImportFile(xlsxBuffer([["姓名", "電話"], ["王小明", "0912345678"]])).rows).toHaveLength(1);
    expect(parseImportFile(Buffer.from("name,phone\nAlice,0912345678\n", "utf8")).rows).toHaveLength(1);
  });

  it("HTML、JSON、含二進位內容的檔案一律拒絕", () => {
    for (const buf of [Buffer.from("<html><table><tr><td>a</td></tr></table></html>"), Buffer.from('{"a":1}'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])]) {
      expect(() => parseImportFile(buf)).toThrow(/無法讀取檔案/);
    }
  });
});
