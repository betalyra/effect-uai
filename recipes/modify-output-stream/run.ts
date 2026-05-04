/**
 * Runner for the modify-output-stream recipe. Drives the conversation
 * against the real Responses provider and prints both wire formats so
 * you can copy a frame straight from the terminal.
 *
 * The recipe maps `Turn.toSSE` / `Turn.toJSONL` over the loop's output
 * with `Stream.filterMap`; that's the whole transport layer.
 * `Turn.asSSE` / `Turn.asJSONL` are the same call spelled as a curried
 * helper you can drop straight into `pipe`.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/modify-output-stream/run.ts`
 */
import { Config, Console, Effect, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as SSE from "@effect-uai/core/SSE"
import * as Turn from "@effect-uai/core/Turn"
import { layer as responsesLayer } from "@effect-uai/responses"
import { conversation } from "./index.js"

const decoder = new TextDecoder("utf-8")

const program = Effect.gen(function* () {
  yield* Console.log("--- as SSE bytes -----------------------------------")
  const sseBytes = conversation.pipe(Stream.filterMap(Turn.toSSE), SSE.toBytes)
  yield* Stream.runForEach(sseBytes, (chunk) => Console.log(decoder.decode(chunk).trimEnd()))

  yield* Console.log("\n--- as JSONL lines ---------------------------------")
  const jsonl = conversation.pipe(Stream.filterMap(Turn.toJSONL))
  yield* Stream.runForEach(jsonl, (line: string) => Console.log(line.trimEnd()))
})

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey })
  }),
)

const runtime = apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer))

Effect.runPromise(program.pipe(Effect.provide(runtime))).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
