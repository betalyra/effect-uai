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
  References,
  Schema,
  Stream,
} from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as AiError from "@betalyra/effect-uai-core/AiError"
import * as Items from "@betalyra/effect-uai-core/Items"
import {
  type Event as LoopEvent,
  loop,
  nextAfter,
  stopAfter,
  value,
} from "@betalyra/effect-uai-core/Loop"
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

const InvalidTimeZone = (timezone: string) =>
  new Error(`Invalid IANA timezone: ${timezone}`)

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

type Cursor = State & { readonly turn: Turn.Turn }

type Event =
  | {
      readonly type: "delta"
      readonly delta: Exclude<Turn.TurnDelta, { readonly type: "turn_complete" }>
    }
  | { readonly type: "turn_complete"; readonly cursor: Cursor }
  | { readonly type: "tool_output"; readonly output: Items.FunctionCallOutput }

const initial: State = {
  history: [Items.userText("What time is it in Lisbon and Tokyo right now?")],
  index: 0,
}

// ---------------------------------------------------------------------------
// The loop - explicit, streaming, and still fully visible
// ---------------------------------------------------------------------------

// One body per turn. Stream deltas immediately; decide whether to continue
// after the terminal `turn_complete` event.
const conversation: Stream.Stream<
  Event,
  AiError.AiError,
  Responses | Toolkit.ToolsR<typeof toolkit.tools>
> = loop(initial, (state) =>
  Effect.gen(function* () {
    const oai = yield* Responses

    const deltas = oai
      .streamTurn(state.history, {
        tools,
        reasoning: { effort: "low" },
      })
      .pipe(Stream.tap((delta) => Effect.logDebug("delta", { delta })))

    return Turn.streamUntilComplete(deltas, {
      emit: (delta): Stream.Stream<LoopEvent<Event, State>> =>
        Stream.succeed(value<Event>({ type: "delta", delta })),
      onMissing: Effect.fail(
        new AiError.Unavailable({
          provider: "openai",
          raw: "Stream ended without turn_complete",
        }),
      ),
      then: (turn) =>
        Effect.gen(function* () {
          const cursor: Cursor = {
            ...state,
            history: [...state.history, ...turn.items],
            turn,
          }
          const calls = Turn.functionCalls(turn)
          const turnComplete = Stream.succeed<Event>({
            type: "turn_complete",
            cursor,
          })

          // No tool calls - the assistant is done.
          if (calls.length === 0) return stopAfter(turnComplete)

          // Run the tools the model asked for. `executeAllSafe` reflects tool
          // failures as `FunctionCallOutput` items so the model can self-correct
          // on the next turn.
          const outputs = yield* Toolkit.executeAllSafe(toolkit, calls)

          const toolOutputs = Stream.fromIterable(
            outputs.map((output): Event => ({ type: "tool_output", output })),
          )

          return nextAfter(Stream.concat(turnComplete, toolOutputs), {
            ...state,
            history: [...cursor.history, ...outputs],
            index: state.index + 1,
          })
        }),
    })
  }),
)

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const final = yield* Stream.runFold(
    conversation.pipe(
      Stream.tap((event) =>
        Match.value(event).pipe(
          Match.discriminator("type")("delta", () =>
            Effect.logDebug("event", { event }),
          ),
          Match.discriminator("type")("tool_output", ({ output }) =>
            Effect.logInfo("tool output", { output }),
          ),
          Match.discriminator("type")("turn_complete", ({ cursor }) =>
            Effect.logInfo(`turn ${cursor.index} complete`, {
              stop_reason: cursor.turn.stop_reason,
              usage: cursor.turn.usage,
            }),
          ),
          Match.exhaustive,
        ),
      ),
    ),
    () => Option.none<Cursor>(),
    (last, event) =>
      Match.value(event).pipe(
        Match.discriminator("type")("turn_complete", ({ cursor }) =>
          Option.some(cursor),
        ),
        Match.orElse(() => last),
      ),
  )

  const cursor = Option.getOrThrowWith(
    final,
    () => new Error("conversation produced no turns"),
  )

  yield* Effect.logInfo("final history items:")
  yield* Effect.forEach(cursor.history, (item) =>
    Effect.logInfo("  item", { item }),
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
  program.pipe(
    Effect.provide(runtime),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
