/**
 * Drive a real OpenAI Responses API conversation through `Stream.paginate`.
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx experiments/responses.ts`
 */
import { Config, DateTime, Effect, Layer, Logger, Option, References, Schema, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { AiError } from "../src/AiError.js"
import * as Items from "../src/Items.js"
import { OpenAi, layer as openAiLayer } from "../src/providers/openai/Responses.js"
import * as Tool from "../src/Tool.js"
import * as Toolkit from "../src/Toolkit.js"
import { functionCalls, type Turn } from "../src/Turn.js"

// ---------------------------------------------------------------------------
// Tool — get_current_time (uses Effect's DateTime)
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

interface Cursor {
  readonly history: ReadonlyArray<Items.Item>
  readonly turn: Turn
  readonly index: number
}

const initial: State = {
  history: [Items.userText("What time is it in Lisbon and Tokyo right now?")],
  index: 0,
}

// ---------------------------------------------------------------------------
// The loop — Stream.paginate, fully visible
// ---------------------------------------------------------------------------

const conversation = Stream.paginate(initial, (state) =>
  Effect.gen(function* () {
    const oai = yield* OpenAi

    const maybeTurn = yield* oai
      .streamTurn(state.history, {
        tools,
        reasoning: { effort: "low" },
      })
      .pipe(
        Stream.tap((delta) => Effect.logDebug("delta", { delta })),
        Stream.runFold(Option.none<Turn>, (acc, delta) =>
          delta.type === "turn_complete" ? Option.some(delta.turn) : acc,
        ),
      )

    if (Option.isNone(maybeTurn)) {
      return yield* new AiError({
        message: "Stream ended without turn_complete",
      })
    }
    const turn = maybeTurn.value

    const history = [...state.history, ...turn.items]
    const cursor: Cursor = { history, turn, index: state.index }
    const calls = functionCalls(turn)

    if (calls.length === 0) {
      return [[cursor], Option.none<State>()] as const
    }

    const outputs = yield* Toolkit.executeAll(toolkit, calls)
    return [
      [cursor],
      Option.some<State>({
        history: [...history, ...outputs],
        index: state.index + 1,
      }),
    ] as const
  }),
)

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const last = yield* Stream.runLast(
    conversation.pipe(
      Stream.tap((cursor) =>
        Effect.logInfo(`turn ${cursor.index} complete`, {
          stop_reason: cursor.turn.stop_reason,
          usage: cursor.turn.usage,
        }),
      ),
    ),
  )

  const final = Option.getOrThrowWith(last, () => new Error("conversation produced no turns"))

  yield* Effect.logInfo("final history items:")
  yield* Effect.forEach(final.history, (item) => Effect.logInfo("  item", { item }))
})

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return openAiLayer({ apiKey, model: "gpt-5.4-mini" })
  }),
)

const runtime = Layer.mergeAll(
  apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
)

Effect.runPromise(
  program.pipe(Effect.provide(runtime), Effect.provideService(References.MinimumLogLevel, "Debug")),
).catch((err) => {
  console.error("experiment failed:", err)
  process.exit(1)
})
