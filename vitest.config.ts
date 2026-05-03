import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "recipes/**/*.test.ts",
      "experiments/*/**/*.test.ts",
    ],
    exclude: ["node_modules/**"],
  },
})
