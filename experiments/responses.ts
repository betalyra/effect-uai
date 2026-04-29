/**
 * Drive a real OpenAI Responses API conversation through an explicit streaming
 * loop. Unlike `Stream.paginate`, model deltas are forwarded as they arrive.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx experiments/responses.ts`
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
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as AiError from "../src/AiError.js";
import * as Conversation from "../src/Conversation.js";
import * as Items from "../src/Items.js";
import {
  OpenAi,
  layer as openAiLayer,
} from "../src/providers/openai/Responses.js";
import * as Tool from "../src/Tool.js";
import * as Toolkit from "../src/Toolkit.js";
import * as Turn from "../src/Turn.js";
import {
  type Event as LoopEvent,
  loop,
  nextAfter,
  stopAfter,
  value,
} from "../src/Loop.js";
import { streamUntilComplete } from "../src/Turn.js";

// ---------------------------------------------------------------------------
// Tool — get_current_time (uses Effect's DateTime)
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

const toolkit = Toolkit.make([getCurrentTime]);
const tools = Toolkit.toDescriptors(toolkit);

// ---------------------------------------------------------------------------
// State and types
// ---------------------------------------------------------------------------

interface State {
  readonly history: ReadonlyArray<Items.Item>;
  readonly index: number;
}

type Cursor = State & { readonly turn: Turn.Turn };

type Event =
  | {
      readonly type: "delta";
      readonly delta: Exclude<
        Turn.TurnDelta,
        { readonly type: "turn_complete" }
      >;
    }
  | { readonly type: "turn_complete"; readonly cursor: Cursor }
  | { readonly type: "tool_output"; readonly output: Items.FunctionCallOutput };

const initial: State = {
  history: [Items.userText("What time is it in Lisbon and Tokyo right now?")],
  index: 0,
};

// ---------------------------------------------------------------------------
// The loop — explicit, streaming, and still fully visible
// ---------------------------------------------------------------------------

// One body per turn. Stream deltas immediately; decide whether to continue
// after the terminal `turn_complete` event.
const conversation: Stream.Stream<
  Event,
  AiError.AiError,
  OpenAi | Toolkit.ToolsR<typeof toolkit.tools>
> = loop(initial, (state) =>
  Effect.gen(function* () {
    const oai = yield* OpenAi;

    const deltas = oai
      .streamTurn(state.history, {
        tools,
        reasoning: { effort: "low" },
      })
      .pipe(Stream.tap((delta) => Effect.logDebug("delta", { delta })));

    return streamUntilComplete(deltas, {
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
          const cursor = Conversation.cursor(state, turn);
          const calls = Turn.functionCalls(turn);
          const turnComplete = Stream.succeed<Event>({
            type: "turn_complete",
            cursor,
          });

          // No tool calls — the assistant is done.
          if (calls.length === 0) return stopAfter(turnComplete);

          // Run the tools the model asked for. If a call fails (e.g. bad
          // arguments), `repair` feeds the error back so the model can
          // self-correct next turn.
          const outputs = yield* Toolkit.executeAllSafe(toolkit, calls);

          const toolOutputs = Stream.fromIterable(
            outputs.map((output): Event => ({ type: "tool_output", output })),
          );

          return nextAfter(Stream.concat(turnComplete, toolOutputs), {
            ...state,
            history: [...cursor.history, ...outputs],
            index: state.index + 1,
          });
        }),
    });
  }),
);

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
  );

  const cursor = Option.getOrThrowWith(
    final,
    () => new Error("conversation produced no turns"),
  );

  yield* Effect.logInfo("final history items:");
  yield* Effect.forEach(cursor.history, (item) =>
    Effect.logInfo("  item", { item }),
  );
});

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY");
    return openAiLayer({ apiKey, model: "gpt-5.4-mini" });
  }),
);

const runtime = Layer.mergeAll(
  apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
);

Effect.runPromise(
  program.pipe(
    Effect.provide(runtime),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
  ),
).catch((err) => {
  console.error("experiment failed:", err);
  process.exit(1);
});
