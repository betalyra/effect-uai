/**
 * One runner for every recipe, on every runtime.
 *
 * A recipe's `run.ts` is a single line, `runRecipe(main)`, because the
 * platform layers are the only thing Node, Bun and Deno disagree on and all
 * three sets live here:
 *
 *   Node   NodeServices + NodeHttpClient.layerUndici  + NodeHttpServer
 *   Bun    BunServices  + FetchHttpClient             + BunHttpServer
 *   Deno   DenoServices + FetchHttpClient             + DenoHttpServer
 *
 * Each set is imported dynamically, so the two runtimes you are not on never
 * load their platform package. `recipes/deno.json` pins
 * `nodeModulesDir: "manual"` so Deno resolves the bare specifiers against the
 * pnpm-installed tree.
 */
import { Config, Effect, Layer, Logger, References } from "effect"
import type { HttpClient } from "effect/unstable/http"
import * as HttpServerNs from "effect/unstable/http/HttpServer"
import type * as HttpServerError from "effect/unstable/http/HttpServerError"
import * as Socket from "effect/unstable/socket/Socket"
import type { NodeServices } from "@effect/platform-node"

/**
 * What every recipe may ask for: an HTTP client, the platform services, and
 * a WebSocket constructor. All three runtimes have a global `WebSocket`, so
 * the realtime speech adapters get one without any recipe wiring it.
 *
 * `NodeServices`, `BunServices` and `DenoServices` are the same union of
 * service tags, so naming one of them types all three.
 */
export type RecipeServices =
  | HttpClient.HttpClient
  | NodeServices.NodeServices
  | Socket.WebSocketConstructor

/** The above plus a bound HTTP server, for recipes that serve a browser client. */
export type ServerServices = RecipeServices | HttpServerNs.HttpServer

type Runtime = "bun" | "deno" | "node"

const runtime: Runtime = "Bun" in globalThis ? "bun" : "Deno" in globalThis ? "deno" : "node"

/** Picks this runtime's branch. The other two stay unevaluated descriptions. */
const on = <A>(cases: Record<Runtime, A>): A => cases[runtime]

const port = Config.port("PORT").pipe(Config.withDefault(3000))

// ---------------------------------------------------------------------------
// Platform services + an HTTP client
// ---------------------------------------------------------------------------

/**
 * Node takes `layerUndici` rather than its built-in fetch: undici handles
 * long-lived SSE bodies, which the built-in drops as `Unavailable` partway
 * through a provider's stream. Bun and Deno have no such problem with theirs.
 */
const platform: Layer.Layer<RecipeServices> = Layer.unwrap(
  on({
    node: Effect.gen(function* () {
      const { NodeHttpClient, NodeServices } = yield* Effect.promise(
        () => import("@effect/platform-node"),
      )
      return Layer.mergeAll(NodeHttpClient.layerUndici, NodeServices.layer)
    }),
    bun: Effect.gen(function* () {
      const { BunHttpClient, BunServices } = yield* Effect.promise(
        () => import("@effect/platform-bun"),
      )
      return Layer.mergeAll(BunHttpClient.layer, BunServices.layer)
    }),
    deno: Effect.gen(function* () {
      const { DenoHttpClient, DenoServices } = yield* Effect.promise(
        () => import("@effect/platform-deno"),
      )
      return Layer.mergeAll(DenoHttpClient.layer, DenoServices.layer)
    }),
  }),
).pipe(Layer.merge(Socket.layerWebSocketConstructorGlobal))

// ---------------------------------------------------------------------------
// The same, plus a server bound to `PORT`
// ---------------------------------------------------------------------------

const server: Layer.Layer<ServerServices, Config.ConfigError | HttpServerError.ServeError> =
  Layer.unwrap(
    on({
      node: Effect.gen(function* () {
        const { createServer } = yield* Effect.promise(() => import("node:http"))
        const { NodeHttpServer } = yield* Effect.promise(() => import("@effect/platform-node"))
        return NodeHttpServer.layer(() => createServer(), {
          port: yield* port,
          gracefulShutdownTimeout: "1 second",
        })
      }),
      bun: Effect.gen(function* () {
        const { BunHttpServer } = yield* Effect.promise(() => import("@effect/platform-bun"))
        return BunHttpServer.layer({ port: yield* port })
      }),
      deno: Effect.gen(function* () {
        const { DenoHttpServer } = yield* Effect.promise(() => import("@effect/platform-deno"))
        return DenoHttpServer.layer({ port: yield* port, gracefulShutdownTimeout: "1 second" })
      }),
    }),
  ).pipe(HttpServerNs.withLogAddress, Layer.merge(platform))

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Pretty console logging at `LOG_LEVEL`, which every recipe wants and none varies. */
const logging = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  Layer.unwrap(
    Effect.map(Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info" as const)), (level) =>
      Layer.succeed(References.MinimumLogLevel, level),
    ),
  ),
)

/**
 * Each runtime's `runMain` sets the exit code, reports the failure, and wires
 * SIGINT/SIGTERM to interruption, so the recipe never handles a signal itself.
 */
const runMain = <E>(main: Effect.Effect<void, E>): Promise<void> =>
  on({
    node: async () => (await import("@effect/platform-node")).NodeRuntime.runMain(main),
    bun: async () => (await import("@effect/platform-bun")).BunRuntime.runMain(main),
    deno: async () => (await import("@effect/platform-deno")).DenoRuntime.runMain(main),
  })()

/** Run a recipe's `main`. This is the whole of a recipe's `run.ts`. */
export const runRecipe = <E>(main: Effect.Effect<void, E, RecipeServices>): Promise<void> =>
  runMain(main.pipe(Effect.provide(Layer.provideMerge(logging, platform))))

/** The same, for a recipe that also binds an HTTP server on `PORT` (default 3000). */
export const serveRecipe = <E>(main: Effect.Effect<void, E, ServerServices>): Promise<void> =>
  runMain(main.pipe(Effect.provide(Layer.provideMerge(logging, server))))
