/**
 * Runner for the tool-call-approval recipe. Wires up the real Responses
 * provider + logging and drives the conversation built in `index.ts`.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/tool-call-approval/run.ts`
 */
import { Config, Effect, Layer, Logger, Match, Queue, References, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { Verdict } from "@effect-uai/core/Resolvers"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { demoVerdict, queueConversation } from "./index.js"

const program = Effect.gen(function* () {
  const verdicts = yield* Queue.unbounded<Verdict>()

  yield* Stream.runForEach(queueConversation(verdicts), (event) =>
    Match.value(event).pipe(
      Match.when({ _tag: "ApprovalRequested" }, (e) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("approval requested", {
            tool: e.tool,
            call_id: e.call_id,
          })
          yield* Effect.sleep("400 millis")
          yield* Queue.offer(verdicts, demoVerdict(e))
        }),
      ),
      Match.when({ _tag: "Output" }, ({ result }) =>
        Effect.logInfo("tool result", {
          call_id: result.call_id,
          tool: result.tool,
          ...(result._tag === "Value"
            ? { value: result.value }
            : { kind: result.kind, reason: result.reason }),
        }),
      ),
      Match.when({ _tag: "Intermediate" }, () => Effect.void),
      Match.discriminators("_tag")({
        TurnComplete: ({ turn }) =>
          Effect.logInfo("turn complete", { stop_reason: turn.stop_reason }),
      }),
      Match.orElse(() => Effect.void),
    ),
  )
})

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey })
  }),
)

const mainLayer = Layer.mergeAll(
  apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program.pipe(
    Effect.provide(mainLayer),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
