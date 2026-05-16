---
name: effect-uai-model-retry
description: Use when the user wants to retry transient model failures (rate limits, transport hiccups, timeouts) with exponential backoff, while letting non-retryable failures (content filtered, auth, invalid request, context length) propagate immediately. Inline pipeline with no helper service.
license: MIT
---

# effect-uai model-retry

Retry rate-limited / transient failures with exponential backoff.
Non-retryable failures (`ContentFiltered`, `AuthFailed`,
`InvalidRequest`, `ContextLengthExceeded`, ...) cross the boundary
unchanged.

Reach for this when the user says any of:

- "Retry on rate limits / 5xx / timeouts"
- "Add exponential backoff to model calls"
- "Don't retry on auth failures or content filter rejections"

## The retryable set

| Tag                     | Retried? | Why                                    |
| ----------------------- | -------- | -------------------------------------- |
| `RateLimited`           | ✓        | transient — provider asking us to wait |
| `Unavailable`           | ✓        | transient — transport / 5xx / DNS      |
| `Timeout`               | ✓        | transient — slow request               |
| `ContentFiltered`       | ✗        | request itself was rejected            |
| `AuthFailed`            | ✗        | wrong key / scope — won't fix itself   |
| `InvalidRequest`        | ✗        | schema / arg error — won't fix itself  |
| `ContextLengthExceeded` | ✗        | needs compaction, not a retry          |
| `Cancelled`             | ✗        | caller asked for it                    |
| `IncompleteTurn`        | ✗        | provider broke contract                |
| `GenerationFailed`      | ✗        | mid-generation provider error          |

## The pipeline

`Stream.retry` retries on any failure, so we can't drop a `Schedule`
straight on top of `streamTurn`. The trick: lift each event into a
tagged `Item` and split the failure channel before the retry layer.

```ts
import { Data, Effect, Schedule, Stream, pipe } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import * as Turn from "@effect-uai/core/Turn"

type Item =
  | { readonly _tag: "Event"; readonly event: Turn.TurnEvent }
  | { readonly _tag: "Terminal"; readonly cause: AiError.AiError }

class Retryable extends Data.TaggedError("Retryable")<{
  readonly cause: AiError.AiError
}> {}

const isRetryable = (
  e: AiError.AiError,
): e is AiError.RateLimited | AiError.Unavailable | AiError.Timeout =>
  e._tag === "RateLimited" || e._tag === "Unavailable" || e._tag === "Timeout"

const backoff = Schedule.exponential("200 millis", 2).pipe(
  Schedule.both(Schedule.recurs(3)), // cap at 3 retries (4 total tries)
  Schedule.jittered, // avoid thundering herd
)

streamTurn(req).pipe(
  Stream.map((event): Item => ({ _tag: "Event", event })),
  Stream.catchIf(
    isRetryable,
    (cause) => Stream.fail(new Retryable({ cause })), // retried
    (cause) => Stream.succeed<Item>({ _tag: "Terminal", cause }), // escapes retry
  ),
  Stream.retry(backoff),
  Stream.catchTag("Retryable", (e) => Stream.fail(e.cause)), // unwrap after exhaustion
  Stream.flatMap((item) =>
    item._tag === "Event" ? Stream.succeed(item.event) : Stream.fail(item.cause),
  ),
)
```

Reading the pipeline:

1. Lift every `TurnEvent` into `{ _tag: "Event", event }`.
2. `catchIf` splits failure: retryable → fail with `Retryable` (the
   only failure the retry layer ever sees); non-retryable → succeed
   with `Terminal` (escapes retry).
3. `Stream.retry(backoff)` walks the schedule on `Retryable`.
4. `catchTag("Retryable", ...)` unwraps the original `AiError` after
   retries are exhausted.
5. `Stream.flatMap` undoes step 1: events pass through; `Terminal`
   items become a stream failure.

Downstream sees a plain `Stream<TurnEvent, AiError>`.

## Caveat: stream replay

`Stream.retry` reruns the _entire_ stream, so any deltas already
emitted before the failure will be **replayed** on the next attempt.
For typical retryable failures (rate-limit / transport errors that hit
before the first delta) that's a non-issue.

For mid-stream failures with at-most-once delta forwarding, retry at
the request boundary instead: use `LanguageModel.turn` (which returns
`Effect<Turn>`) inside `Effect.retry({ schedule, while })`, then
materialize the result as a synthetic `[TurnComplete]` stream. You
lose live streaming inside an attempt, but you don't replay partial
output.

## Tuning the schedule

```ts
// 200ms → 400ms → 800ms (default)
Schedule.exponential("200 millis", 2)

// Cap at N retries
Schedule.both(exp, Schedule.recurs(N - 1))

// Jitter to avoid thundering herd
Schedule.jittered

// Per-tier policies (different schedules for different errors):
// route distinct error tags through distinct Retryable types and
// stack two Stream.retry layers.
```

## See also

- Recipe source: `recipes/model-retry/index.ts`
- For falling back to a different provider on retryable failures: `effect-uai-multi-model-fallback`
- For canceling an in-flight retry: `effect-uai-mid-stream-abort`
