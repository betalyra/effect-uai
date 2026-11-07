/**
 * Streaming tool output: two tools whose `run` returns a `Stream`.
 *
 *   - Sub-agent (`makeSubAgent`)
 *       run: an inner agent's text, as the answer so far
 *
 *   - Progress (`makeDownloadTool`)
 *       run: one snapshot per chunk, then the completed download
 *
 * Every element but the last reaches the consumer as a `ToolEvent.Partial`;
 * the last is the result the model sees. A partial has the tool's own output
 * type, so a UI decodes and renders it with the same schema as the result.
 *
 * This file exports the building blocks; `app.ts` wires the provider.
 */
import { Duration, Effect, Schema, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// Pattern 1: sub-agent. `run` is parametrized over a `runInner` so tests
// inject a mocked `Stream<TurnEvent>` and production passes a real
// inner-loop stream.
// ---------------------------------------------------------------------------

const SubAgentInput = Schema.Struct({ question: Schema.String })

export const SubAgentOutput = Schema.Struct({ answer: Schema.String })
export type SubAgentOutput = typeof SubAgentOutput.Type

export const makeSubAgent = (
  runInner: (question: string) => Stream.Stream<Turn.TurnEvent, unknown, never>,
) =>
  Tool.make({
    name: "ask_subagent",
    description: "Ask a specialist sub-agent for help with a hard question.",
    inputSchema: SubAgentInput,
    outputSchema: SubAgentOutput,
    // The answer so far, one snapshot per text delta; the last is the full answer.
    run: ({ question }) =>
      runInner(question).pipe(
        Turn.textDeltas,
        Stream.scan(
          () => "",
          (answer, text: string) => answer + text,
        ),
        Stream.map((answer): SubAgentOutput => ({ answer })),
      ),
    strict: true,
  })

// ---------------------------------------------------------------------------
// Pattern 2: progress. One snapshot per chunk while running, then the
// completed download. Progress is part of the output type, so the model's
// final value carries it too.
// ---------------------------------------------------------------------------

export const DownloadOutput = Schema.Struct({
  status: Schema.Literals(["running", "completed"]),
  pct: Schema.Number,
  chunks: Schema.Number,
  bytes: Schema.String,
})
export type DownloadOutput = typeof DownloadOutput.Type

const DownloadInput = Schema.Struct({
  url: Schema.String,
  /** number of chunks to fake. Defaults to 4. */
  chunks: Schema.optional(Schema.Number),
})

/**
 * Configurable per-chunk delay so callers can dial up/down for demos
 * vs. tests.
 */
export const makeDownloadTool = (perChunkDelay: Duration.Input = "150 millis") =>
  Tool.make({
    name: "download_artifact",
    description:
      "Download bytes from a URL. Reports progress while running; the model receives the final byte payload.",
    inputSchema: DownloadInput,
    outputSchema: DownloadOutput,
    run: ({ url, chunks }) => {
      const total = chunks ?? 4
      const running = Stream.range(1, total).pipe(
        Stream.mapEffect((chunk) =>
          Effect.delay(
            Effect.succeed<DownloadOutput>({
              status: "running",
              pct: Math.round((chunk / total) * 100),
              chunks: chunk,
              bytes: "",
            }),
            perChunkDelay,
          ),
        ),
      )
      const completed = Stream.succeed<DownloadOutput>({
        status: "completed",
        pct: 100,
        chunks: total,
        bytes: `bytes-of-${url}`,
      })
      return Stream.concat(running, completed)
    },
    strict: true,
  })

// ---------------------------------------------------------------------------
// Recipe shape - identical to basic-usage; only the toolkit differs.
// ---------------------------------------------------------------------------

export interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly index: number
}

export const DEFAULT_MODEL = "gpt-5.4-mini"

/** Build a conversation against the given toolkit. */
export const buildConversation = <T extends Toolkit.Toolkit>(
  toolkit: T,
  initial: State,
  model = DEFAULT_MODEL,
) =>
  pipe(
    initial,
    loop((state: State) =>
      Effect.gen(function* () {
        const lm = yield* LanguageModel
        return lm.streamTurn({ history: state.history, model, tools: toolkit }).pipe(
          onTurnComplete((turn) =>
            Effect.sync(() => {
              const calls = Turn.getToolCalls(turn)
              if (calls.length === 0) return stop()
              return Toolkit.run(toolkit, calls).pipe(
                Toolkit.next(toolkit, { ...state, index: state.index + 1 }, turn),
              )
            }),
          ),
        )
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Production `runInner` for the sub-agent: a real inner loop against the
// same provider with a focused system prompt. Stays separate from the
// recipe body so tests can inject mocks without spinning up an HTTP
// client.
// ---------------------------------------------------------------------------

export const realInnerAgent = (
  question: string,
  model = DEFAULT_MODEL,
): Stream.Stream<Turn.TurnEvent, unknown, never> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const lm = yield* LanguageModel
      return lm.streamTurn({
        history: [
          Items.userText(
            `You are a focused specialist. Answer concisely.\n\nQuestion: ${question}`,
          ),
        ],
        model,
      })
    }),
  ) as Stream.Stream<Turn.TurnEvent, unknown, never>
