/**
 * Multi-turn conversation with auto-compaction. Once the running history
 * crosses a turn or token budget, summarize all but the last few items via
 * the model and replace them with the summary. Then keep going.
 *
 * The driver here is a queue of pending user prompts: after each assistant
 * turn we inject the next prompt; when empty, we stop. This keeps the
 * recipe focused on the compaction mechanic itself.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/auto-compaction/index.ts`
 */
import { Config, Effect, Layer, Logger, Match, References, Stream, pipe } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import * as Items from "@effect-uai/core/Items"
import { loop, next, stop, onTurnComplete } from "@effect-uai/core/Loop"
import * as Turn from "@effect-uai/core/Turn"
import { Responses, layer as responsesLayer } from "@effect-uai/responses/Responses"

// ---------------------------------------------------------------------------
// Compaction policy - dial these down to make the demo fire after few turns.
// ---------------------------------------------------------------------------

const MAX_TURNS = 2
const MAX_INPUT_TOKENS = 50_000
const KEEP_RECENT_ITEMS = 2

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly turnIndex: number
  readonly cumulativeInputTokens: number
  readonly pendingPrompts: ReadonlyArray<string>
}

const PROMPTS = [
  "Tell me one short fact about Lisbon.",
  "Now Tokyo, please.",
  "Now Rio.",
  "Now Paris.",
  "And finally Cairo.",
]

const initial: State = {
  history: [
    Items.systemText("You are a friendly tour guide. Reply in 1-2 short sentences per city."),
    Items.userText(PROMPTS[0]!),
  ],
  turnIndex: 0,
  cumulativeInputTokens: 0,
  pendingPrompts: PROMPTS.slice(1),
}

const advance = (state: State, turn: Turn.Turn): State => ({
  history: [...state.history, ...turn.items],
  turnIndex: state.turnIndex + 1,
  cumulativeInputTokens: state.cumulativeInputTokens + (turn.usage.input_tokens ?? 0),
  pendingPrompts: state.pendingPrompts,
})

const shouldCompact = (state: State): boolean =>
  state.turnIndex >= MAX_TURNS || state.cumulativeInputTokens >= MAX_INPUT_TOKENS

const withSummary = (state: State, summary: string): State => ({
  history: [
    Items.userText(`[Summary of earlier conversation]: ${summary}`),
    ...state.history.slice(-KEEP_RECENT_ITEMS),
  ],
  // Reset both counters so the loop can run another `MAX_TURNS` worth of
  // normal turns before compacting again.
  turnIndex: 0,
  cumulativeInputTokens: 0,
  pendingPrompts: state.pendingPrompts,
})

// ---------------------------------------------------------------------------
// The loop - normal turn OR compaction step
// ---------------------------------------------------------------------------

const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses

      // -----------------------------------------------------------------
      // Compaction step: summarize the early history via the model and
      // replace it with the summary, preserving the last few items.
      // -----------------------------------------------------------------
      if (shouldCompact(state)) {
        const toCompact = state.history.slice(0, -KEEP_RECENT_ITEMS)
        // Compaction is a cheap summarization job - use the small/fast model
        // even though normal turns run on the bigger one.
        return oai
          .streamTurn({
            history: [
              ...toCompact,
              Items.userText(
                "Summarize the conversation above in 2-3 sentences for use as context.",
              ),
            ],
            model: "gpt-5.4-mini",
            tools: [],
            reasoning: { effort: "low" },
          })
          .pipe(
            onTurnComplete((turn) =>
              Effect.sync(() => {
                const summary = Turn.assistantTexts(turn).join(" ")
                return next(withSummary(state, summary))
              }),
            ),
          )
      }

      // -----------------------------------------------------------------
      // Normal turn: stream a response, then either inject the next user
      // prompt or stop when the queue is empty.
      // -----------------------------------------------------------------
      return oai
        .streamTurn({
          history: state.history,
          model: "gpt-5.4",
          tools: [],
          reasoning: { effort: "low" },
        })
        .pipe(
          Stream.tap((delta) => Effect.logDebug("delta", { delta })),
          onTurnComplete((turn) =>
            Effect.sync(() => {
              const nextState = advance(state, turn)
              if (state.pendingPrompts.length === 0) return stop()
              const [nextPrompt, ...rest] = state.pendingPrompts
              return next({
                ...nextState,
                history: [...nextState.history, Items.userText(nextPrompt!)],
                pendingPrompts: rest,
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

const program = Stream.runForEach(conversation, (event) =>
  Match.value(event).pipe(
    Match.discriminators("_tag")({
      TurnComplete: ({ turn }) =>
        Effect.logInfo("turn complete", {
          stop_reason: turn.stop_reason,
          input_tokens: turn.usage.input_tokens,
          output_tokens: turn.usage.output_tokens,
          assistant: Turn.assistantTexts(turn).join(" "),
        }),
    }),
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

Effect.runPromise(
  program.pipe(
    Effect.provide(mainLayer),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
