import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["integration-tests/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // microVM boot + image pull on first run can take several seconds
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
