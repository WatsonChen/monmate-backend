import { AppError } from "../lib/http.js";
import { getAbuseConfig } from "../config/abuse.js";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

type SiteverifyResponse = { success: boolean; "error-codes"?: string[]; hostname?: string };

export const turnstileService = {
  // 未設定 TURNSTILE_SECRET_KEY 時視為功能關閉（現有部署不受影響）
  isEnabled() {
    return getAbuseConfig().turnstileSecret !== null;
  },

  // 驗證通過才回傳；失敗一律丟錯，呼叫端必須在新增名單與扣點「之前」呼叫。
  // 失敗時 fail closed：驗證服務暫時不可用也不放行，避免被利用來繞過防護。
  async verify(input: { token?: string; ip?: string | null; idempotencyKey?: string }): Promise<void> {
    const secret = getAbuseConfig().turnstileSecret;
    if (!secret) return;

    const token = input.token?.trim();
    if (!token) throw new AppError(400, "CAPTCHA_REQUIRED", "請先完成人機驗證");
    if (token.length > 4096) throw new AppError(400, "CAPTCHA_FAILED", "人機驗證失敗，請重新驗證");

    const body = new URLSearchParams({ secret, response: token });
    if (input.ip) body.set("remoteip", input.ip);
    // 以同一個 idempotency_key 重試，Cloudflare 會回傳同一個結果，不會因重試被當成重複使用
    if (input.idempotencyKey) body.set("idempotency_key", input.idempotencyKey);

    let result: SiteverifyResponse | null = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        const res = await fetch(SITEVERIFY_URL, {
          method: "POST",
          body,
          signal: AbortSignal.timeout(5000)
        });
        if (res.ok) result = (await res.json()) as SiteverifyResponse;
      } catch {
        /* 網路錯誤或逾時：重試一次 */
      }
    }
    if (!result) {
      throw new AppError(503, "CAPTCHA_UNAVAILABLE", "驗證服務暫時無法使用，請稍後再試");
    }

    if (result.success) return;

    const codes = result["error-codes"] ?? [];
    if (codes.includes("timeout-or-duplicate")) {
      throw new AppError(400, "CAPTCHA_EXPIRED", "驗證已過期或已使用，請重新驗證");
    }
    if (codes.includes("internal-error")) {
      throw new AppError(503, "CAPTCHA_UNAVAILABLE", "驗證服務暫時無法使用，請稍後再試");
    }
    throw new AppError(400, "CAPTCHA_FAILED", "人機驗證失敗，請重新驗證");
  }
};
