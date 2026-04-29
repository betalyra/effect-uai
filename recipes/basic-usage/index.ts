/**
 * Drive a real OpenAI Responses API conversation through an explicit streaming
 * loop. Model deltas are forwarded as they arrive; the loop continues whenever
 * the assistant asks for tool calls and stops once it produces a final answer.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-usage/index.ts`
 */
import {
  Config,
  DateTime,
  Effect,
  Layer,
  Logger,
  Match,
  Option,
  pipe,
  References,
  Schema,
  Stream,
} from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@betalyra/effect-uai-core/Items"
import { loop, nextAfter, stop, streamUntilComplete } from "@betalyra/effect-uai-core/Loop"
import { matchType } from "@betalyra/effect-uai-core/Match"
import * as Tool from "@betalyra/effect-uai-core/Tool"
import * as Toolkit from "@betalyra/effect-uai-core/Toolkit"
import * as Turn from "@betalyra/effect-uai-core/Turn"
import { Responses, layer as responsesLayer } from "@betalyra/effect-uai-responses"

// ---------------------------------------------------------------------------
// Tool - get_current_time (uses Effect's DateTime)
// ---------------------------------------------------------------------------

const GetCurrentTimeInput = Schema.Struct({
  timezone: Schema.String,
})

const InvalidTimeZone = (timezone: string) => new Error(`Invalid IANA timezone: ${timezone}`)

const getCurrentTime = Tool.make({
  name: "get_current_time",
  description:
    "Look up the current local time for an IANA timezone, e.g. 'Europe/Lisbon' or 'Asia/Tokyo'.",
  inputSchema: Tool.fromEffectSchema(GetCurrentTimeInput),
  run: ({ timezone }) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        DateTime.setZoneNamed(now, timezone).pipe(
          Option.match({
            onNone: () => Effect.fail(InvalidTimeZone(timezone)),
            onSome: (zoned) =>
              Effect.succeed({
                timezone,
                iso: DateTime.formatIsoZoned(zoned),
              }),
          }),
        ),
      ),
    ),
  strict: true,
})

const toolkit = Toolkit.make([getCurrentTime])
const tools = Toolkit.toDescriptors(toolkit)

// ---------------------------------------------------------------------------
// State and types
// ---------------------------------------------------------------------------

interface State {
  readonly history: ReadonlyArray<Items.Item>
  readonly index: number
}

const initial: State = {
  history: [Items.userText("What time is it in Lisbon and Tokyo right now?")],
  index: 0,
}

// ---------------------------------------------------------------------------
// The loop - explicit, streaming, and still fully visible
// ---------------------------------------------------------------------------

// Run a multi-turn conversation: stream the model's response, execute any
// tools it asks for, feed the results back, and keep going until the model
// produces a final answer.
const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses

      return oai
        .streamTurn(state.history, {
          tools,
          reasoning: { effort: "low" },
        })
        .pipe(
          Stream.tap((delta) => Effect.logDebug("delta", { delta })),
          streamUntilComplete((turn) =>
            Effect.gen(function* () {
              const next = Turn.cursor(state, turn)
              const calls = Turn.functionCalls(turn)

              // No tool calls - the assistant is done.
              if (calls.length === 0) return stop

              // `executeAllSafe` reflects tool failures as `FunctionCallOutput`
              // items so the model can self-correct on the next turn.
              const outputs = yield* Toolkit.executeAllSafe(toolkit, calls)

              return nextAfter(Stream.fromIterable(outputs), {
                ...next,
                history: [...next.history, ...outputs],
                index: state.index + 1,
              })
            }),
          ),
        )
    }),
  ),
)

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  yield* Stream.runForEach(conversation, (event) =>
    Match.value(event).pipe(
      matchType("turn_complete", ({ turn }) =>
        Effect.logInfo("turn complete", {
          stop_reason: turn.stop_reason,
          usage: turn.usage,
        }),
      ),
      matchType("function_call_output", (output) =>
        Effect.logInfo("tool output", { output }),
      ),
      Match.orElse(() => Effect.logDebug("delta", { event })),
    ),
  )
})

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey, model: "gpt-5.4-mini" })
  }),
)

const runtime = Layer.mergeAll(
  apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program.pipe(Effect.provide(runtime), Effect.provideService(References.MinimumLogLevel, "Debug")),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
