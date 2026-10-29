// 測試只能連本機的測試資料庫；任何看起來不是本機測試庫的連線一律拒絕，避免誤碰正式資料。
import { userInfo } from "node:os";

const url =
  process.env.TEST_DATABASE_URL ?? `postgresql://${userInfo().username}@localhost:5432/monmate_test?schema=public`;
const parsed = new URL(url);
const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
if (!isLocal || !parsed.pathname.replace("/", "").endsWith("_test")) {
  throw new Error(`拒絕執行：測試資料庫必須是本機且名稱以 _test 結尾（目前為 ${parsed.hostname}${parsed.pathname}）`);
}
process.env.DATABASE_URL = url;
process.env.DIRECT_URL = url;
process.env.JWT_SECRET = "test-secret-test-secret-test-secret";
process.env.NODE_ENV = "test";

// 測試用的藍新金鑰（假值）：只用來驗證本地簽章與入帳邏輯，測試不會連到藍新
process.env.NEWEBPAY_MERCHANT_ID = "MS_TEST_0001";
process.env.NEWEBPAY_HASH_KEY = "k".repeat(32);
process.env.NEWEBPAY_HASH_IV = "i".repeat(16);
