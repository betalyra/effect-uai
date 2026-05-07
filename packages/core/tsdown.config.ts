import { defineConfig } from "tsdown"

export default defineConfig({
  entry: ["src/**/*.ts"],
  format: "esm",
  dts: { sourcemap: true },
  sourcemap: true,
  clean: true,
  target: "es2022",
  outDir: "dist",
})
