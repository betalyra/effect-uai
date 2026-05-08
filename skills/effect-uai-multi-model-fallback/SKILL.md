---
name: effect-uai-multi-model-fallback
description: Use when the user wants to fall back from a primary provider/model to a secondary on retryable failures (rate-limited, unavailable). Reuses the same history; non-retryable failures (content filtered, auth, etc.) propagate. Tier list is plain data — add as many tiers as needed.
license: MIT
---

# effect-uai multi-model-fallback

Try the primary provider; on `RateLimited` or `Unavailable`, advance
the loop state to the next tier and retry the same `state.history`.
Other typed `AiError` variants propagate to the caller.

Reach for this when the user says any of:

- "Fall back from OpenAI to Gemini if rate-limited"
- "Try a cheaper model first, expensive one if it fails"
- "Multi-tier provider failover"

## State + tiers

```ts
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import * as Items from "@effect-uai/core/Items"

interface Tier {
  readonly name: string
  readonly model: string
  readonly service: LanguageModelService
}

interface State {
  readonly history: ReadonlyArray<Items.Item>
  readonly tier: number
}
```

## The loop body

```ts
import { Effect, Stream, pipe } from "effect"
import { loop, nextAfter, stop, onTurnComplete } from "@effect-uai/core/Loop"

const conversation = (tiers: ReadonlyArray<Tier>) =>
  pipe(
    { history: [Items.userText("...")], tier: 0 } as State,
    loop((state) =>
      Effect.gen(function* () {
        const tier = tiers[state.tier]
        if (tier === undefined) return stop // exhausted

        const advanceTier = (reason: string) =>
          Effect.logWarning(`${tier.name}: ${reason} - falling back`).pipe(
            Effect.as(nextAfter(Stream.empty, { ...state, tier: state.tier + 1 })),
          )

        return tier.service.streamTurn({ history: state.history, model: tier.model }).pipe(
          // Success path: first complete turn ends the loop.
          onTurnComplete(() => Effect.sync(() => stop)),
          // Only retryable errors become continuation; everything else propagates.
          Stream.catchTag("RateLimited", () => Stream.unwrap(advanceTier("rate-limited"))),
          Stream.catchTag("Unavailable", () => Stream.unwrap(advanceTier("unavailable"))),
        )
      }),
    ),
  )
```

## Wiring providers as tiers

```ts
import { make as makeResponses } from "@effect-uai/responses"
import { make as makeGemini } from "@effect-uai/google"

const program = Effect.gen(function* () {
  const openai = yield* makeResponses({ apiKey: openaiKey })
  const gemini = yield* makeGemini({ apiKey: googleKey })

  const tiers: ReadonlyArray<Tier> = [
    { name: "openai/gpt-5.4-mini", model: "gpt-5.4-mini", service: openai },
    { name: "google/gemini-2.5-flash", model: "gemini-2.5-flash", service: gemini },
  ]

  yield* Stream.runDrain(conversation(tiers))
})
```

`make({ apiKey })` returns a `LanguageModelService` value (vs.
`layer({ apiKey })` which returns a Layer). Use `make` when you want
to swap services per call instead of provide one for the whole
program.

## The same `state.history` is reused

The fallback returns `nextAfter(Stream.empty, { ...state, tier: state.tier + 1 })`
without calling `Turn.appendTurn` — the failed turn's items are NOT
in history, so the next tier sees the same prompt as the original
attempt.

## Combining with retry

For "retry within tier, then fall back," compose:

1. Wrap each `tier.service.streamTurn(req)` with the retry pipeline
   from `effect-uai-model-retry`.
2. The `RateLimited` / `Unavailable` errors that survive retries
   become tier advancement.

## See also

- Recipe source: `recipes/multi-model-fallback/index.ts`
- For retrying within one tier: `effect-uai-model-retry`
- For voting / consensus across tiers: `effect-uai-model-council`
- For comparing tier outputs side-by-side: `effect-uai-multi-model-compare`
