---
name: effect-uai-auto-compaction
description: Use when the user is worried about long conversations exceeding the context window or the input-token budget — summarize earlier history into one item once a turn / token threshold is crossed, keep the last few items verbatim, then continue. The compaction step is just another streamTurn; history is just state.
license: MIT
---

# effect-uai auto-compaction

History is just state. Compaction is just a state transition. When the
running history crosses a turn or token budget, summarize all but the
last few items via the model and replace them with the summary, then
keep going.

Reach for this when the user says any of:

- "My agent runs out of context window after long conversations"
- "Summarize chat history when it gets too long"
- "Token budget management for chat agents"

## State

```ts
interface State {
  readonly history: ReadonlyArray<Items.Item>
  readonly turnIndex: number
  readonly cumulativeInputTokens: number
  readonly pendingPrompts: ReadonlyArray<string>
}

const MAX_TURNS = 10
const KEEP_RECENT_ITEMS = 4

const shouldCompact = (state: State) => state.turnIndex >= MAX_TURNS
```

The library doesn't care what's on state — add `turnIndex`,
`cumulativeInputTokens`, `pendingPrompts`, anything you need for the
compaction decision.

## The two branches

```ts
import { Effect, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { loop, nextAfter, stop, onTurnComplete } from "@effect-uai/core/Loop"
import * as Turn from "@effect-uai/core/Turn"
import { Responses } from "@effect-uai/responses"

const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses

      if (shouldCompact(state)) {
        // Compaction step: summarize the early history, replace it.
        const toCompact = state.history.slice(0, -KEEP_RECENT_ITEMS)
        return oai
          .streamTurn({
            history: [
              ...toCompact,
              Items.userText(
                "Summarize the conversation above in 2-3 sentences for use as context.",
              ),
            ],
            model: "gpt-5.4-mini",
            reasoning: { effort: "low" },
          })
          .pipe(
            onTurnComplete((turn) =>
              Effect.sync(() => {
                const summary = Turn.assistantMessages(turn)
                  .flatMap((m) => m.content)
                  .filter(Items.isOutputText)
                  .map((c) => c.text)
                  .join(" ")
                return nextAfter(Stream.empty, withSummary(state, summary))
              }),
            ),
          )
      }

      // Normal turn (bigger model, etc.)
      return oai.streamTurn({ history: state.history, model: "gpt-5.4" }).pipe(
        onTurnComplete((turn) =>
          Effect.sync(() => {
            const next = advance(state, turn)
            if (next.pendingPrompts.length === 0) return stop
            const [nextPrompt, ...rest] = next.pendingPrompts
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

const withSummary = (state: State, summary: string): State => ({
  history: [Items.userText(`[Summary]: ${summary}`), ...state.history.slice(-KEEP_RECENT_ITEMS)],
  turnIndex: 0,
  cumulativeInputTokens: 0,
  pendingPrompts: state.pendingPrompts,
})

const advance = (state: State, turn: Turn.Turn): State => ({
  history: [...state.history, ...turn.items],
  turnIndex: state.turnIndex + 1,
  cumulativeInputTokens: state.cumulativeInputTokens + (turn.usage.input_tokens ?? 0),
  pendingPrompts: state.pendingPrompts,
})
```

## Tuning knobs

- `MAX_TURNS` / `MAX_INPUT_TOKENS` — when compaction fires.
- `KEEP_RECENT_ITEMS` — how many trailing items survive verbatim.
- The summarization prompt and model — swap for a cheaper model,
  change the instruction, etc.
- `reasoning: { effort: "low" }` is appropriate for the summarization
  call.

## Across user sessions

The recipe compacts within one loop invocation. Real chat
applications usually persist `state.history` between requests:

- **Lazy, at load time.** If the hydrated history exceeds your
  budget, run a compaction `streamTurn` _before_ starting the agent
  loop, then continue with the compacted history.
- **Eager, at save time.** When the loop finishes a request, check
  the budget; compact and persist the smaller history.
- **Background.** After the user-facing response returns, kick off
  compaction asynchronously and overwrite the stored history. Best
  for latency-sensitive UIs.

## See also

- Recipe source: `recipes/auto-compaction/index.ts`
- For long-lived chat agents that need this: `effect-uai-agentic-loop`
- For pausing the loop between turns: `effect-uai-pause-resume`
