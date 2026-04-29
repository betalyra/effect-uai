---
title: Auto-compaction
description: Summarize history when turn count or token budget is exceeded.
---

# Recipe: Auto memory compaction

**Scenario.** History grows. After 10 turns or 50k cumulative tokens, kick
off a compaction step that summarizes history-so-far via a smaller model
and replaces history with `[summary]`.

This recipe shows state-threaded predicates and a body that runs a
summarizer call before continuing the loop.

```ts
const cumulativeTokens = state.cumulativeTokens + (turn.usage.totalTokens ?? 0)
if (cumulativeTokens >= MAX_TOKENS || state.index + 1 >= MAX_TURNS) {
  // run compaction, then next({ history: [summary], ... })
}
```

## Why a recipe, not a primitive

The trigger predicate, summarizer model, and replacement strategy are all
application choices. The loop primitive stays agnostic.

## Status

Scaffolded only. Depends on populated `Turn.usage` and stable `Items` schema
(see `plans/use-case-new-implementation.md` §5).
