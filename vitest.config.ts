import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@monmate/types": `${root}packages/types/src/index.ts`,
      "@monmate/utils": `${root}packages/utils/src/index.ts`
    }
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // 所有測試共用同一個測試資料庫，序列執行避免互相清資料
    fileParallelism: false,
    testTimeout: 30000
  }
});
