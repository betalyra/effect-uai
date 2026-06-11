/**
 * Drive a real OpenAI Responses API conversation through an explicit streaming
 * loop. Model deltas are forwarded as they arrive; the loop continues whenever
 * the assistant asks for tool calls and stops once it produces a final answer.
 *
 * `index.ts` exports the building blocks; the runner lives in `run.ts`.
 */
import { DateTime, Effect, Option, pipe, Schema, Stream } from "effect";
import * as Items from "@effect-uai/core/Items";
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop";
import * as Tool from "@effect-uai/core/Tool";
import * as Toolkit from "@effect-uai/core/Toolkit";
import * as Turn from "@effect-uai/core/Turn";
import { Responses } from "@effect-uai/responses/Responses";
import { LanguageModel } from "@effect-uai/core/LanguageModel";

// ---------------------------------------------------------------------------
// Tool - get_current_time (uses Effect's DateTime)
// ---------------------------------------------------------------------------

const GetCurrentTimeInput = Schema.Struct({
  timezone: Schema.String,
});

const InvalidTimeZone = (timezone: string) =>
  new Error(`Invalid IANA timezone: ${timezone}`);

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
});

const allTools = [getCurrentTime];
const tools = Tool.toDescriptors(allTools);

// ---------------------------------------------------------------------------
// State and types
// ---------------------------------------------------------------------------

interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>;
  readonly index: number;
}

const initial: State = {
  history: [Items.userText("What time is it in Lisbon and Tokyo right now?")],
  index: 0,
};

// ---------------------------------------------------------------------------
// The loop - explicit, streaming, and still fully visible
// ---------------------------------------------------------------------------

// Run a multi-turn conversation: stream the model's response, execute any
// tools it asks for, feed the results back, and keep going until the model
// produces a final answer.
export const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const lm = yield* LanguageModel;

      return lm
        .streamTurn({
          history: state.history,
          model: "gpt-5.4-mini",
          tools,
        })
        .pipe(
          Stream.tap((delta) => Effect.logDebug("delta", { delta })),
          onTurnComplete((turn) =>
            Effect.sync(() => {
              const calls = Turn.getToolCalls(turn);

              // No tool calls - the assistant is done.
              if (calls.length === 0) return stop();

              // Stream tool events to the consumer; on end-of-stream
              // emit one `Loop.next` carrying the appended turn.
              // `continueWithResults` is the broadcast pattern bundled into one
              // call - see `Loop.value` / `Toolkit.collectResults` /
              // `Loop.next` if you ever need to vary an arm.
              return Toolkit.run(allTools, calls).pipe(
                Toolkit.continueWithResults(
                  Toolkit.appendToolResults(
                    { ...state, index: state.index + 1 },
                    turn,
                  ),
                ),
              );
            }),
          ),
        );
    }),
  ),
);
