/**
 * Runtime-agnostic browser bundling via rolldown's JS API.
 *
 * Replaces per-runtime bundler choice (`Bun.build`, `esbuild`, etc.):
 * any runner can call `bundleClient(entry)` and serve the resulting
 * ESM string from the same code path. The native rolldown binary
 * ships per-platform but the call itself is just JS.
 */
import { Data, Effect } from "effect"
import { rolldown } from "rolldown"

export class BundleError extends Data.TaggedError("BundleError")<{
  readonly entry: string
  readonly cause: unknown
}> {}

export class EmptyBundleError extends Data.TaggedError("EmptyBundleError")<{
  readonly entry: string
}> {}

export const bundleClient = (
  entry: string,
): Effect.Effect<string, BundleError | EmptyBundleError> =>
  Effect.gen(function* () {
    const bundle = yield* Effect.tryPromise({
      try: () => rolldown({ input: entry }),
      catch: (cause) => new BundleError({ entry, cause }),
    })

    const result = yield* Effect.tryPromise({
      try: () => bundle.generate({ format: "esm" }),
      catch: (cause) => new BundleError({ entry, cause }),
    })

    const first = result.output[0]
    if (first === undefined || first.type !== "chunk") {
      return yield* new EmptyBundleError({ entry })
    }
    return first.code
  })
