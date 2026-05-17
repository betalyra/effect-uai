---
title: Model retry
description: Retry rate-limited and transport failures with exponential backoff; let everything else propagate.
source: recipes/model-retry
icon: PiClockCounterClockwise
---

Retries are not an agent framework feature. They are error policy around one
stream.

This recipe shows the retry shape inline in a normal loop body: retry transient
provider failures with exponential backoff, while letting semantic or permanent
failures cross the boundary immediately.

**Scenario.** A streamed model turn hits `RateLimited`, `Unavailable`, or
`Timeout`. Wait a bit and try again. If the failure is `ContentFiltered`,
`AuthFailed`, `InvalidRequest`, or another non-transient error, fail loudly
instead of burning retries.

## The Design Move

`Stream.retry` retries any failure it sees. The trick is to make sure it only
sees failures you actually want retried.

The stream is temporarily lifted into a small local union:

- model events become `{ _tag: "Event", event }`;
- retryable errors fail as `Retryable`;
- non-retryable errors become `{ _tag: "Terminal", cause }`, a value that
  escapes the retry layer.

After the retry schedule finishes, the recipe unwraps everything back into the
plain `Stream<TurnEvent, AiError>` the rest of the loop expects.

## The retryable set

Three `AiError` tags get retried. Everything else propagates as-is.

| Tag                     | Retried? | Why                                        |
| ----------------------- | -------- | ------------------------------------------ |
| `RateLimited`           | ✓        | transient — provider is asking us to wait  |
| `Unavailable`           | ✓        | transient — transport / 5xx / DNS          |
| `Timeout`               | ✓        | transient — slow request                   |
| `ContentFiltered`       | ✗        | the request itself was rejected            |
| `AuthFailed`            | ✗        | wrong key / wrong scope — won't fix itself |
| `InvalidRequest`        | ✗        | schema / arg error — won't fix itself      |
| `ContextLengthExceeded` | ✗        | needs compaction, not a retry              |
| `Cancelled`             | ✗        | caller asked for it                        |
| `IncompleteTurn`        | ✗        | provider broke contract                    |
| `GenerationFailed`      | ✗        | mid-generation provider error              |

## The pipeline

```ts
streamTurn(req).pipe(
  Stream.map((event): Item => ({ _tag: "Event", event })),
  Stream.catchIf(
    isRetryable,
    (cause) => Stream.fail(new Retryable({ cause })), // retried
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

1. Keep normal turn events as values.
2. Convert only retryable provider errors into the failure type consumed by
   `Stream.retry`.
3. Smuggle non-retryable errors past the retry layer as terminal values.
4. Restore the original `AiError` channel before handing the stream downstream.

Downstream still sees a plain model turn stream. Retry is a local policy, not a
new abstraction that leaks through the rest of the program.

## The schedule

```ts
const backoff = Schedule.exponential("200 millis", 2).pipe(
  Schedule.both(Schedule.recurs(3)),
  Schedule.jittered,
)
```

This means 200ms, 400ms, 800ms, capped at three retries (four total tries),
with jitter so many clients do not retry in lockstep.

Tune the constants for your product. If `RateLimited` and `Unavailable` should
use different policies, split `Retryable` into separate tagged errors and run
them through different retry layers.

## Pre-packaged: `Retry.stream` / `Retry.effect`

The exact lift / `Stream.retry` / unlift pattern above ships as a one-import
helper. Two carriers, same subset:

```ts
import * as Retry from "@effect-uai/core/Retry"

// Stream — same shape as this recipe
streamTurn(req).pipe(Retry.stream(backoff))

// Effect — for `turn`, `embed`, `synthesize`, `transcribe`, …
turn(req).pipe(Retry.effect(backoff))
embed(req).pipe(Retry.effect(backoff))
```

Both are scoped to `RateLimited | Unavailable | Timeout`; non-retryable errors
bypass. Reach for them when you don't need to customize the lifted-item shape.
This recipe spells the pattern out so you can adapt it (e.g. split `RateLimited`
and `Unavailable` onto different schedules) without having to rediscover the
trick.

`Retry.stream` and `Retry.effect` deliberately don't collide with Effect's
`Stream.retry` and `Effect.retry` — the namespace makes it obvious which one
is the subset-aware variant.

## Caveat: stream replay

`Stream.retry` reruns the entire stream. If the provider emitted deltas before
the failure, those deltas can be replayed on the next attempt.

For rate limits and transport failures that happen before the first delta, this
is exactly what you want. For mid-stream failures where the UI must never see a
delta twice, retry at the request boundary instead: use
`turn(req).pipe(Retry.effect(backoff))` and materialize the completed turn as a
synthetic stream. You lose live streaming inside an attempt, but you get
at-most-once forwarding.

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
