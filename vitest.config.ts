import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["server/**/*.test.ts", "client/**/*.test.ts", "client/**/*.test.tsx"],
    exclude: ["node_modules", "dist", "my_pro_chall"],
    testTimeout: 10_000,
  },
});
