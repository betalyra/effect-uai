import { defineConfig } from "tsdown"

export default defineConfig([
  {
    entry: ["src/**/*.ts", "!src/**/*.test.ts", "!src/worklets/**"],
    format: "esm",
    dts: { sourcemap: true },
    sourcemap: true,
    clean: true,
    target: "es2022",
    outDir: "dist",
  },
  // One build per worklet, so each is a self-contained file (no shared chunk):
  // `addModule` loads it on its own.
  ...["mic", "player"].map((name) => ({
    entry: [`src/worklets/${name}.ts`],
    format: "esm" as const,
    dts: false,
    target: "es2022",
    outDir: "dist/worklets",
  })),
])
