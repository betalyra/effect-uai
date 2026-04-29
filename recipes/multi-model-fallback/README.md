---
title: Multi-model fallback
description: Fall back across providers on RateLimited or Unavailable; give up on ContentFiltered.
---

# Recipe: Multi-model fallback

**Scenario.** Try OpenAI; on `RateLimited` or `Unavailable`, fall back to
Anthropic; on `ContentFiltered`, give up.

This recipe shows the `loop` + typed `AiError` + state-carried fallbacks
pattern. The same `state.history` is reused across the fallback because we
never advanced past the failed turn.

```ts
loop(initial, (state) =>
  streamTurn(state).pipe(
    Stream.catchTags({
      RateLimited: handleFallback,
      Unavailable: handleFallback,
    }),
  ),
)
```

## Why a recipe, not a primitive

State threading + typed errors is more flexible than a built-in fallback
combinator. `Effect.ExecutionPlan` covers a different shape (per-error-class
declarative plan); both are valid. This recipe shows the hand-rolled
state-machine version that keeps the loop visible.

## Status

Scaffolded only. Implementation pending - depends on Tier-1 typed `AiError`
variants (see `plans/use-case-new-implementation.md` §3, §4).
