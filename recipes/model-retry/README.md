---
title: Model retry
description: Retry rate-limited and transport failures with exponential backoff; let everything else propagate.
---

**Scenario.** Your model call hits a `RateLimited` or `Unavailable`
during a turn. You want to wait a bit and try again — up to a few times,
with each delay longer than the last — but only for the failures that
make sense to retry. `ContentFiltered`, `AuthFailed`, `InvalidRequest`
should fail loudly and immediately.

This recipe is the retry shape inlined into a normal loop body. No
wrapper service, no helper function: just `streamTurn` followed by a
small `catchIf → retry → catchTag → flatMap` pipeline.

## The retryable set

Three `AiError` tags get retried. Everything else propagates as-is:

| Tag                      | Retried? | Why                                       |
| ------------------------ | -------- | ----------------------------------------- |
| `RateLimited`            | ✓        | transient — provider is asking us to wait |
| `Unavailable`            | ✓        | transient — transport / 5xx / DNS         |
| `Timeout`                | ✓        | transient — slow request                  |
| `ContentFiltered`        | ✗        | the request itself was rejected           |
| `AuthFailed`             | ✗        | wrong key / wrong scope — won't fix itself |
| `InvalidRequest`         | ✗        | schema / arg error — won't fix itself     |
| `ContextLengthExceeded`  | ✗        | needs compaction, not a retry             |
| `Cancelled`              | ✗        | caller asked for it                       |
| `IncompleteTurn`         | ✗        | provider broke contract                   |
| `GenerationFailed`       | ✗        | mid-generation provider error             |

## The pipeline

`Stream.retry` retries on any failure, so we can't drop the `Schedule`
straight on top of `streamTurn` and expect it to gate on the error
tag. The trick: lift each event into a tagged `Item` and split the
failure channel before the retry layer.

```ts
streamTurn(req).pipe(
  Stream.map((event): Item => ({ _tag: "Event", event })),
  Stream.catchIf(
    isRetryable,
    (cause) => Stream.fail(new Retryable({ cause })),     // retried
    (cause) => Stream.succeed<Item>({ _tag: "Terminal", cause }), // escapes retry
  ),
  Stream.retry(backoff),
  Stream.catchTag("Retryable", (e) => Stream.fail(e.cause)),
  Stream.flatMap((item) =>
    item._tag === "Event" ? Stream.succeed(item.event) : Stream.fail(item.cause),
  ),
)
```

Reading the pipeline:

1. `Stream.map` lifts every `TurnEvent` into `{ _tag: "Event", event }`.
2. `Stream.catchIf` splits the failure channel:
   - retryable errors fail with `Retryable` (the only thing the retry
     layer should ever see),
   - non-retryable errors *succeed* with `{ _tag: "Terminal", cause }`,
     so they never trigger retry.
3. `Stream.retry(backoff)` walks the schedule on `Retryable` failures.
4. `Stream.catchTag("Retryable", ...)` unwraps the original `AiError`
     after retries are exhausted.
5. `Stream.flatMap` undoes step 1: events pass through, `Terminal`
     items become a stream failure.

Downstream sees a plain `Stream<TurnEvent, AiError>`, indistinguishable
from a non-retried call.

## The schedule

```ts
const backoff = Schedule.exponential("200 millis", 2).pipe(
  Schedule.both(Schedule.recurs(3)),
  Schedule.jittered,
)
```

- `Schedule.exponential("200 millis", 2)` — 200ms, 400ms, 800ms, ...
- `Schedule.both(..., recurs(3))` — *and* at most three retries. `both`
  only continues while every component schedule continues, so this
  caps the loop at 4 total tries (1 + 3).
- `Schedule.jittered` — randomize each delay to avoid thundering herd
  when many clients all retry at once.

Tune by editing the constants. Per-tier policies (different schedule
for `RateLimited` than `Unavailable`) are a small extension: replace
the single `Retryable` tag with one per error category and run them
through different `Stream.retry` layers.

## Caveat: stream replay

`Stream.retry` reruns the *entire* stream, so any deltas already
emitted before the failure will be **replayed** on the next attempt.
For typical retryable failures (rate-limit / transport errors that hit
before the first delta) that's a non-issue — there are no deltas yet.

For mid-stream failures where you want at-most-once delta forwarding,
retry at the request boundary instead: use `LanguageModel.turn` (which
returns `Effect<Turn>`) inside `Effect.retry({ schedule, while })`,
then materialize the result as a synthetic `[turn_complete]` stream.
You lose live streaming inside an attempt, but you don't replay
partial output.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/model-retry/run.ts
```

The runner just drives a single conversation against OpenAI; retries
will only fire if the API actually returns a retryable failure during
the run. The unit tests in
[`index.test.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/model-retry/index.test.ts)
cover the retry behavior offline against a flaky in-memory model.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/model-retry/index.ts).
