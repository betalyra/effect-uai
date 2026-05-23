import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Boot + API round-trips can take a few seconds; default 120s is
    // generous but matches the Deno-side 30 min sandbox max.
    testTimeout: 120_000,
    hookTimeout: 60_000,
  },
})
