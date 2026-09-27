import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.{ts,tsx}", "packages/*/src/**/*.test.ts", "apps/desktop/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 15_000,
  },
});
