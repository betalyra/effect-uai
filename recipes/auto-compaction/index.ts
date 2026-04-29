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
import * as Items from "@betalyra/effect-uai-core/Items"
import { loop, nextAfter, stop, streamUntilComplete } from "@betalyra/effect-uai-core/Loop"
import * as Turn from "@betalyra/effect-uai-core/Turn"
import { Responses, layer as responsesLayer } from "@betalyra/effect-uai-responses"

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
  readonly history: ReadonlyArray<Items.Item>
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
        return oai
          .streamTurn(
            [
              ...toCompact,
              Items.userText(
                "Summarize the conversation above in 2-3 sentences for use as context.",
              ),
            ],
            { tools: [], reasoning: { effort: "low" } },
          )
          .pipe(
            streamUntilComplete((turn) =>
              Effect.sync(() => {
                const summary = Turn.assistantMessages(turn)
                  .flatMap((m) => m.content)
                  .filter((c): c is Items.OutputText => c.type === "output_text")
                  .map((c) => c.text)
                  .join(" ")
                return nextAfter(Stream.empty, withSummary(state, summary))
              }),
            ),
          )
      }

      // -----------------------------------------------------------------
      // Normal turn: stream a response, then either inject the next user
      // prompt or stop when the queue is empty.
      // -----------------------------------------------------------------
      return oai.streamTurn(state.history, { tools: [], reasoning: { effort: "low" } }).pipe(
        Stream.tap((delta) => Effect.logDebug("delta", { delta })),
        streamUntilComplete((turn) =>
          Effect.sync(() => {
            const next = advance(state, turn)
            if (state.pendingPrompts.length === 0) return stop
            const [nextPrompt, ...rest] = state.pendingPrompts
            return nextAfter(Stream.empty, {
              ...next,
              history: [...next.history, Items.userText(nextPrompt!)],
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

const program = Effect.gen(function* () {
  yield* Stream.runForEach(conversation, (event) =>
    Match.value(event).pipe(
      Match.discriminator("type")("turn_complete", ({ turn }) =>
        Effect.logInfo("turn complete", {
          stop_reason: turn.stop_reason,
          input_tokens: turn.usage.input_tokens,
          output_tokens: turn.usage.output_tokens,
          assistant: Turn.assistantMessages(turn)
            .flatMap((m) => m.content)
            .filter((c): c is Items.OutputText => c.type === "output_text")
            .map((c) => c.text)
            .join(" "),
        }),
      ),
      Match.orElse(() => Effect.void),
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
  program.pipe(Effect.provide(runtime), Effect.provideService(References.MinimumLogLevel, "Info")),
).catch((err) => {
  console.error("recipe failed:", err)
  process.exit(1)
})
