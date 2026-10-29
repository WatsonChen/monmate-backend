// 公開報名防護設定。全部可由環境變數調整，執行時才讀取（方便測試與不重新部署就調整）。
// 數字是「初始保守值」，不是已驗證的安全門檻，需依實際流量觀察後調整。
function int(name: string, fallback: number) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function getAbuseConfig() {
  return {
    // 硬性限制（超過回 429）：固定視窗，分開計算
    limits: {
      eventPerMinute: int("ABUSE_LIMIT_EVENT_PER_MIN", 600), // 單一活動的總請求
      phonePerMinute: int("ABUSE_LIMIT_PHONE_PER_MIN", 5), // 單一活動內同一支電話的請求
      ipPerMinute: int("ABUSE_LIMIT_IP_PER_MIN", 120), // 單一來源 IP 的總請求（僅在設定可信 IP 標頭時啟用）
      captchaFailPer10Min: int("ABUSE_LIMIT_CAPTCHA_FAIL_PER_10MIN", 20) // 單一來源驗證碼失敗次數（僅在設定可信 IP 標頭時啟用）
    },
    // 觀察與告警門檻（只記錄與通知，不封鎖、不暫停）
    alerts: {
      eventSuccessPer5Min: int("ABUSE_ALERT_EVENT_PER_5MIN", 100),
      ipSuccessPer10Min: int("ABUSE_ALERT_IP_PER_10MIN", 30),
      cooldownSeconds: int("ABUSE_ALERT_COOLDOWN_SECONDS", 15 * 60)
    },
    // 只信任這一個標頭作為來源 IP；未設定時不做 IP 維度的限制，避免把代理的位址當成使用者
    trustedIpHeader: (process.env.TRUSTED_IP_HEADER ?? "").trim().toLowerCase() || null,
    turnstileSecret: (process.env.TURNSTILE_SECRET_KEY ?? "").trim() || null
  };
}
