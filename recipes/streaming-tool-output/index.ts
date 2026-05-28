/**
 * Streaming tool output: two patterns of `Tool.streaming`.
 *
 *   - Sub-agent (`makeSubAgent`)
 *       run: returns a `Stream<TurnEvent>` from an inner agent
 *       finalize: joins text deltas into the final answer
 *
 *   - Progress + result (`makeDownloadTool`)
 *       run: emits progress events, then a single terminal result event
 *       finalize: ignores progress; picks the result for the model
 *
 * Both flow inner events through to the consumer as
 * `ToolEvent.Progress`s in real time. The outer model only ever sees
 * `finalize(events)` as the structured `Output`. The dual-view pattern
 * (rich UI for the user, clean data for the model) is what makes
 * `Tool.streaming` worth its complexity.
 *
 * `index.ts` exports the building blocks; the runner lives in `run.ts`.
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

export interface SubAgentOutput {
  readonly answer: string
}

export const makeSubAgent = (
  runInner: (question: string) => Stream.Stream<Turn.TurnEvent, unknown, never>,
) =>
  Tool.streaming({
    name: "ask_subagent",
    description: "Ask a specialist sub-agent for help with a hard question.",
    inputSchema: Tool.fromEffectSchema(SubAgentInput),
    run: ({ question }) => runInner(question),
    finalize: (events): SubAgentOutput => ({
      answer: events
        .filter((e): e is Extract<Turn.TurnEvent, { _tag: "TextDelta" }> => e._tag === "TextDelta")
        .map((e) => e.text)
        .join(""),
    }),
    strict: true,
  })

// ---------------------------------------------------------------------------
// Pattern 2: progress + terminal result. `run` emits one `progress`
// event per chunk plus one terminal `result` event. `finalize` ignores
// progress events and picks the result for the model.
// ---------------------------------------------------------------------------

export type DownloadEvent =
  | { readonly type: "progress"; readonly pct: number; readonly chunk: number }
  | { readonly type: "result"; readonly bytes: string }

export interface DownloadOutput {
  readonly status: "completed" | "failed"
  readonly bytes: string
  readonly chunks: number
}

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
  Tool.streaming({
    name: "download_artifact",
    description:
      "Download bytes from a URL. Emits progress events while running; the model receives the final byte payload.",
    inputSchema: Tool.fromEffectSchema(DownloadInput),
    run: ({ url, chunks }) => {
      const total = chunks ?? 4
      const next = (i: number): readonly [DownloadEvent, number] | undefined => {
        if (i > total) return undefined
        if (i === total) return [{ type: "result", bytes: `bytes-of-${url}` }, i + 1]
        return [
          {
            type: "progress",
            pct: Math.round(((i + 1) / total) * 100),
            chunk: i + 1,
          },
          i + 1,
        ]
      }
      return Stream.unfold(0, (i: number) => {
        const step = next(i)
        if (step === undefined) return Effect.succeed(undefined)
        return step[0].type === "result"
          ? Effect.succeed(step)
          : Effect.delay(Effect.succeed(step), perChunkDelay)
      })
    },
    finalize: (events): DownloadOutput => {
      const result = events.find(
        (e): e is Extract<DownloadEvent, { type: "result" }> => e.type === "result",
      )
      const chunks = events.filter((e) => e.type === "progress").length
      return result
        ? { status: "completed", bytes: result.bytes, chunks }
        : { status: "failed", bytes: "", chunks }
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

/** Build a conversation against the given toolkit. */
export const buildConversation = (allTools: ReadonlyArray<Tool.AnyTool>, initial: State) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        const lm = yield* LanguageModel
        return lm
          .streamTurn({
            history: state.history,
            model: "gpt-5.4-mini",
            tools: Tool.toDescriptors(allTools),
          })
          .pipe(
            onTurnComplete((turn) =>
              Effect.sync(() => {
                const calls = Turn.getToolCalls(turn)
                if (calls.length === 0) return stop()

                return Toolkit.run(allTools, calls).pipe(
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

// ---------------------------------------------------------------------------
// Production `runInner` for the sub-agent: a real inner loop against the
// same provider with a focused system prompt. Stays separate from the
// recipe body so tests can inject mocks without spinning up an HTTP
// client.
// ---------------------------------------------------------------------------

export const realInnerAgent = (question: string): Stream.Stream<Turn.TurnEvent, unknown, never> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const lm = yield* LanguageModel
      return lm.streamTurn({
        history: [
          Items.userText(
            `You are a focused specialist. Answer concisely.\n\nQuestion: ${question}`,
          ),
        ],
        model: "gpt-5.4-mini",
      })
    }),
  ) as Stream.Stream<Turn.TurnEvent, unknown, never>
