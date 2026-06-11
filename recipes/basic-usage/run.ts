/**
 * Runner for the basic-usage recipe. Wires up the real Responses provider
 * + logging and drives the conversation built in `index.ts`.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-usage/run.ts`
 */
import { Config, Effect, Layer, Logger, Match, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"
import { conversation } from "./index.js"

// Print straight to stdout so the demo reads like a chat: assistant text
// streams in token by token, tool calls and their results show inline.
const write = (s: string) => Effect.sync(() => process.stdout.write(s))

const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

const program = Stream.runForEach(conversation, (event) =>
  Match.value(event).pipe(
    // Assistant prose, as it streams.
    Match.tag("TextDelta", ({ text }) => write(text)),
    // A tool call: name in cyan, JSON arguments stream in plain text after.
    Match.tag("ToolCallStart", ({ name }) => write(`\n${cyan(`🔧 ${name}`)} `)),
    Match.tag("ToolCallArgsDelta", ({ delta }) => write(delta)),
    // The tool's result, dim under its call.
    Match.tag("Output", ({ result }) =>
      write(
        dim(`   ↳ ${result._tag === "Ok" ? JSON.stringify(result.value) : `failed: ${result.kind}`}`) +
          "\n",
      ),
    ),
    // End of a turn: reset any dim styling and break the line.
    Match.tag("TurnComplete", () => write("\x1b[0m\n")),
    Match.orElse(() => Effect.void),
  ),
)

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

Effect.runPromise(program.pipe(Effect.provide(mainLayer))).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
