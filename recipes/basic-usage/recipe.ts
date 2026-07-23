/**
 * The canonical effect-uai agent loop: stream a model turn, run any tools the
 * model asks for, feed the results back, and continue until it produces a final
 * answer. This is the runtime-agnostic core.
 *
 * It is built against the generic `LanguageModel` tag and parameterized by model
 * id, so the same loop runs against any provider. `app.ts` chooses the provider
 * Layer (here a chat-completions gateway) and the runners supply the platform
 * `HttpClient`.
 */
import { DateTime, Effect, Option, pipe, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"

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

const toolkit = Toolkit.make(getCurrentTime)

// ---------------------------------------------------------------------------
// State and types
// ---------------------------------------------------------------------------

interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly index: number
}

const initial: State = {
  history: [Items.userText("What time is it in Lisbon and Tokyo right now?")],
  index: 0,
}

// ---------------------------------------------------------------------------
// The loop - explicit, streaming, and still fully visible
// ---------------------------------------------------------------------------

/**
 * Run a multi-turn conversation: stream the model's response, execute any tools
 * it asks for, feed the results back, and keep going until the model produces a
 * final answer. Parameterized by model id so the same loop runs against any
 * `LanguageModel` provider.
 */
export const makeConversation = (model: string) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        const lm = yield* LanguageModel

        return lm
          .streamTurn({
            history: state.history,
            model,
            tools: toolkit,
          })
          .pipe(
            Stream.tap((delta) => Effect.logDebug("delta", { delta })),
            onTurnComplete((turn) =>
              Effect.sync(() => {
                const calls = Turn.getToolCalls(turn)

                // No tool calls - the assistant is done.
                if (calls.length === 0) return stop()

                // Stream tool events to the consumer; on end-of-stream emit one
                // `Loop.next` carrying the appended turn.
                return Toolkit.run(toolkit, calls).pipe(
                  Toolkit.continueWithResults(
                    Toolkit.appendToolResults({ ...state, index: state.index + 1 }, turn),
                  ),
                )
              }),
            ),
          )
      }),
    ),
  )
