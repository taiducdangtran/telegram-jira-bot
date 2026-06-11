// Test các hàm thuần (time.ts, util.ts) — chạy môi trường node thường,
// không cần @cloudflare/vitest-pool-workers vì không đụng KV/AI binding.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
