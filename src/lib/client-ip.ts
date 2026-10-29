import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Request } from "express";
import { getAbuseConfig } from "../config/abuse.js";

// 只讀取明確設定為「可信」的單一標頭（TRUSTED_IP_HEADER），其餘一律忽略：
// 標頭名稱裡有 vercel、forwarded 並不代表可信，必須先確認實際的代理鏈再設定。
// 值含逗號（多層代理串接、可能夾帶偽造內容）或不是合法 IP 時，視為取不到來源 IP。
export function getClientIp(req: Pick<Request, "headers">): string | null {
  const header = getAbuseConfig().trustedIpHeader;
  if (!header) return null;
  const raw = req.headers[header];
  const value = Array.isArray(raw) ? (raw.length === 1 ? raw[0] : undefined) : raw;
  if (typeof value !== "string") return null;
  const ip = value.trim();
  if (ip.includes(",") || isIP(ip) === 0) return null;
  return ip;
}

// 紀錄與計數只使用雜湊後的 IP，避免在資料庫保存原始 IP
export function hashIp(ip: string) {
  return createHash("sha256")
    .update(`${process.env.JWT_SECRET ?? ""}:${ip}`)
    .digest("hex")
    .slice(0, 16);
}
