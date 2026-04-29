---
title: Multi-model fallback
description: Try OpenAI; on RateLimited or Unavailable, fall back to Gemini; on ContentFiltered, give up.
---

# Recipe: Multi-model fallback

**Scenario.** Try OpenAI (`gpt-5.4-mini`). If it returns `RateLimited` or
`Unavailable`, advance to the next tier (Gemini `gemini-3-flash-preview`)
with the same `state.history` and try again. Other typed `AiError`
variants - `ContentFiltered`, `AuthFailed`, `ContextLengthExceeded`,
`InvalidRequest` - propagate to the caller. The first successful turn
ends the loop.

The same shape works for any number of tiers. Add more entries to the
`tiers` array; the loop walks them in order until one succeeds or the
list is exhausted.

## What it shows

- Building two distinct `LanguageModelService` values via `Responses.make`
  and `Gemini.make`, then selecting between them by an index threaded
  through state.
- Catching specific `AiError` tags with `Stream.catchTag` to convert a
  failure into a state advance (`nextAfter(Stream.empty, { tier: tier + 1 })`)
  instead of letting it terminate the stream.
- Letting non-retryable errors fall through unchanged - the rest of the
  union (`ContentFiltered`, `InvalidRequest`, etc.) crosses the loop
  boundary and surfaces in the caller's error channel.

## The loop, in shape

```ts
const conversation = (tiers: ReadonlyArray<Tier>) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        const tier = tiers[state.tier]
        if (tier === undefined) return stop // exhausted

        const advanceTier = (reason: string) =>
          Effect.logWarning(`${tier.name}: ${reason} - falling back`).pipe(
            Effect.as(nextAfter(Stream.empty, { ...state, tier: state.tier + 1 })),
          )

        return tier.service.streamTurn(state.history, {}).pipe(
          streamUntilComplete(() => Effect.sync(() => stop)),
          Stream.catchTag("RateLimited", () => Stream.unwrap(advanceTier("rate-limited"))),
          Stream.catchTag("Unavailable", () => Stream.unwrap(advanceTier("unavailable"))),
        )
      }),
    ),
  )
```

The same `state.history` is reused on the fallback because the body
returned `nextAfter(..., { ...state, tier: state.tier + 1 })` rather than
calling `Turn.cursor(state, turn)` - we never advanced past the failed
turn.

## Forcing the fallback in the live demo

To see the fallback fire against real APIs, the recipe configures the
primary tier with a deliberately broken `baseUrl`:

```ts
const openai = yield* makeResponses({
  apiKey: openaiKey,
  model: "gpt-5.4-mini",
  baseUrl: "https://invalid-host.example.invalid/v1",
})
```

The HTTP client fails to resolve the host, the provider maps it to
`AiError.Unavailable`, and the loop advances to the Gemini tier which
runs against the real endpoint and produces the answer.

## Run it

```sh
OPENAI_API_KEY=sk-... GOOGLE_API_KEY=... pnpm tsx recipes/multi-model-fallback/index.ts
```

The full source lives next to this README at
[`recipes/multi-model-fallback/index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/multi-model-fallback/index.ts).
