import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const root = process.cwd();
const out = join(root, ".emit-test");

afterAll(() => rmSync(out, { recursive: true, force: true }));

// Vercel 的 Express 零設定「不打包」：先用 tsc 編譯，再由 Node 依一般的模組解析載入。
// 單元測試用的路徑別名（@monmate/* 指向 .ts）會遮住「從只有型別的套件匯入執行時的值」這類錯誤，
// 所以這裡模擬部署環境：編譯後直接用 Node 載入整個應用，確認能啟動。
describe("部署環境啟動檢查（編譯後不經打包直接用 Node 載入）", () => {
  it("應用程式能被載入並且 /health 可以回應", () => {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    execFileSync(
      join(root, "node_modules/.bin/tsc"),
      ["-p", "tsconfig.json", "--noEmit", "false", "--outDir", out, "--declaration", "false", "--rootDir", "."],
      { cwd: root, stdio: "pipe" }
    );
    writeFileSync(
      join(out, "boot.mjs"),
      `const { default: app } = await import("./src/app.js");
       const server = app.listen(0, async () => {
         const r = await fetch("http://127.0.0.1:" + server.address().port + "/health");
         console.log("BOOT_RESULT " + r.status + " " + (await r.text()));
         server.close(); process.exit(0);
       });`
    );
    const url = process.env.DATABASE_URL!;
    const stdout = execFileSync("node", [join(out, "boot.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url, JWT_SECRET: "boot-check-secret-boot-check-secret" },
      timeout: 40_000
    });
    expect(stdout).toContain("BOOT_RESULT 200");
    expect(stdout).toContain('"status":"ok"');
  }, 90_000);
});
