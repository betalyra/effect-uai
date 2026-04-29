---
title: Mid-stream abort
description: Cancel the loop and abort the upstream HTTP request via scope-based cleanup.
---

# Recipe: Mid-stream abort

**Scenario.** User clicks "stop". Server must interrupt the loop _and_
abort the upstream HTTP request to the model provider.

Effect's structured concurrency model already does this when the chain is
correctly scoped: when the loop's outer scope closes, the HTTP client's
finalizer fires and `FetchHttpClient` aborts via `AbortController`.

```ts
const abort = yield * Deferred.make<void>()
conversation.pipe(Stream.interruptWhen(Deferred.await(abort)))
// elsewhere:
yield * Deferred.succeed(abort, undefined)
```

## Why a recipe, not a primitive

The cleanup chain is composition: scope finalizers are how Effect manages
this. The recipe's job is to wire the user-facing trigger and verify the
chain end-to-end.

## Status

Scaffolded only. Verification work pending: regression test that drives a
fake `streamTurn` whose finalizer flips a flag, cancels the outer stream,
asserts the flag fired (see `plans/use-case-new-implementation.md` §10).
