/**
 * Retry a streamed turn with exponential backoff. Retryable failures
 * (rate limits, transport hiccups, timeouts) are absorbed by
 * `Stream.retry`; non-retryable failures (`ContentFiltered`,
 * `AuthFailed`, `InvalidRequest`, ...) cross the boundary unchanged.
 *
 * The trick is gating retry. `Stream.retry` retries on any failure, so
 * we lift each event into a tagged item and use `catchIf` to split the
 * `AiError` failure channel:
 *
 *   - retryable error  →  fail with `Retryable`  (Stream.retry latches on this)
 *   - other AiError    →  succeed with `Terminal` (escapes retry untouched)
 *
 * After `Stream.retry` runs, `Retryable` failures become the original
 * `AiError`, and `Terminal` items get re-failed. The downstream
 * consumer sees a plain `Stream<TurnEvent, AiError>`.
 *
 *   streamTurn(req)
 *     ── catchIf ───→ retryable → Retryable (failure)
 *                  └→ non-retryable → Terminal (value)
 *     ── retry ────→ schedule fires only when the failure is `Retryable`
 *     ── catchTag ─→ unwrap `Retryable` after retries are exhausted
 *     ── flatMap ──→ unwrap `Terminal` items back into a failure
 *
 * Caveat. `Stream.retry` reruns the *entire* stream, so any deltas
 * already emitted before the failure will be replayed on the next
 * attempt. For typical retryable failures (rate-limit / transport
 * errors that hit before the first delta) that's a non-issue. If your
 * provider fails *mid-stream* and you want at-most-once forwarding,
 * retry at the request boundary via `LanguageModel.turn` (an
 * `Effect<Turn>`) inside `Effect.retry`, then materialize as a
 * synthetic stream.
 *
 * `index.ts` exports the `conversation`; the runner lives in `run.ts`.
 */
import { Data, Effect, Schedule, Stream, pipe } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
import * as Turn from "@effect-uai/core/Turn"

// ---------------------------------------------------------------------------
// Lifted item: every TurnEvent becomes an `Event`; non-retryable failures
// are encoded as `Terminal` values that escape the retry layer.
// ---------------------------------------------------------------------------

type Item =
  | { readonly _tag: "Event"; readonly event: Turn.TurnEvent }
  | { readonly _tag: "Terminal"; readonly cause: AiError.AiError }

class Retryable extends Data.TaggedError("Retryable")<{
  readonly cause: AiError.AiError
}> {}

const isRetryable = (
  error: AiError.AiError,
): error is AiError.RateLimited | AiError.Unavailable | AiError.Timeout =>
  error._tag === "RateLimited" || error._tag === "Unavailable" || error._tag === "Timeout"

// ---------------------------------------------------------------------------
// Backoff: 200ms → 400ms → 800ms, capped at three retries (4 total
// tries), jittered to avoid thundering herd.
// ---------------------------------------------------------------------------

const backoff = Schedule.exponential("200 millis", 2).pipe(
  Schedule.both(Schedule.recurs(3)),
  Schedule.jittered,
)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface State {
  readonly history: ReadonlyArray<Items.Item>
}

export const initial: State = {
  history: [Items.userText("Give me one short fact about Lisbon.")],
}

// ---------------------------------------------------------------------------
// The loop. Retry happens inline around `streamTurn`.
// ---------------------------------------------------------------------------

export const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const lm = yield* LanguageModel
      return lm.streamTurn({ history: state.history, model: "gpt-5.4-mini" }).pipe(
        Stream.map((event): Item => ({ _tag: "Event", event })),
        Stream.catchIf(
          isRetryable,
          (cause) => Stream.fail(new Retryable({ cause })),
          (cause) => Stream.succeed<Item>({ _tag: "Terminal", cause }),
        ),
        Stream.retry(backoff),
        Stream.catchTag("Retryable", (e) => Stream.fail(e.cause)),
        Stream.flatMap((item) =>
          item._tag === "Event" ? Stream.succeed(item.event) : Stream.fail(item.cause),
        ),
        onTurnComplete<State, never>(() => Effect.sync(() => stop)),
      )
    }),
  ),
)
