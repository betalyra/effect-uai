import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    // Each suite downloads a vocabulary from the Hub, a few MB over the wire.
    testTimeout: 120_000,
  },
})
