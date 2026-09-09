/**
 * What an adapter author needs and a recipe author never sees: text
 * splitting at a platform ceiling, and post-then-edit progressive delivery
 * for platforms without a native streaming API.
 */
import { Array as Arr, Clock, Data, Duration, Effect, Option, Schedule, Stream } from "effect"
import {
  CurrentConversation,
  type MessageId,
  type MessengerService,
  type StreamOptions,
  text,
} from "./Messenger.js"
import type * as MessengerError from "./MessengerError.js"

// ---------------------------------------------------------------------------
// Text splitting
// ---------------------------------------------------------------------------

// Paragraph break first, then line break, then space.
const boundaries = ["\n\n", "\n", " "] as const

/** Best split at or before `limit`; a hard cut only for an unbroken run. */
const cutAt = (body: string, limit: number): readonly [head: string, rest: string] =>
  body.length <= limit
    ? [body, ""]
    : Arr.findFirst(boundaries, (sep) =>
        Option.map(
          Option.liftPredicate(body.lastIndexOf(sep, limit - sep.length), (at) => at > 0),
          (at) => [body.slice(0, at), body.slice(at + sep.length)] as const,
        ),
      ).pipe(Option.getOrElse(() => [body.slice(0, limit), body.slice(limit)] as const))

/**
 * Chunk `body` into pieces no longer than `limit`, breaking on paragraph,
 * line, then word boundaries. Always yields at least one chunk, so callers
 * have something to send even for empty input.
 */
export const splitForLimit = (body: string, limit: number): Arr.NonEmptyReadonlyArray<string> => {
  const [head, rest] = cutAt(body, limit)
  return rest.length === 0 ? [head] : [head, ...splitForLimit(rest, limit)]
}

// ---------------------------------------------------------------------------
// streamViaEdits
// ---------------------------------------------------------------------------

/** The slice of a messenger that {@link streamViaEdits} drives. */
export type EditableVerbs = Pick<MessengerService, "post" | "edit" | "limits">

export type StreamViaEditsOptions = {
  /** Minimum wall time between edits. Default 1 second. */
  readonly every?: Duration.Input
  /** Minimum growth since the last edit before spending another. Default 40. */
  readonly minChars?: number
  /** How often to honour a `MessengerRateLimited` before giving up. Default 3. */
  readonly rateLimitRetries?: number
}

const isRateLimited = (e: MessengerError.MessengerError): boolean =>
  e._tag === "MessengerRateLimited"

// A retry schedule's input is the error, so the delay is the platform's own
// `retry_after` rather than a guess. Bounded by `recurs`, so an unlucky call
// eventually surfaces the rate limit instead of stalling behind it.
const honourRetryAfter = (
  times: number,
): Schedule.Schedule<number, MessengerError.MessengerError> =>
  Schedule.recurs(times).pipe(
    Schedule.setInputType<MessengerError.MessengerError>(),
    Schedule.modifyDelay(({ input }) =>
      Effect.succeed(input._tag === "MessengerRateLimited" ? input.retryAfter : Duration.zero),
    ),
  )

/**
 * The message being filled: not on the platform yet, or posted and edited
 * since. Only the first draft carries the reply; rollover drafts do not.
 */
type Progress = Data.TaggedEnum<{
  Draft: { readonly pending: string; readonly envelope: StreamOptions }
  Sent: {
    readonly id: MessageId
    /** Text the message shows now. Never resent unchanged. */
    readonly sent: string
    /** Text it should show, deltas included. */
    readonly pending: string
    readonly lastFlush: number
  }
}>

const Progress = Data.taggedEnum<Progress>()

type Sent = Data.TaggedEnum.Value<Progress, "Sent">

const appended = (s: Progress, delta: string): Progress => ({
  ...s,
  pending: s.pending + delta,
})

/**
 * Progressive delivery as post-then-edit, for adapters with no native
 * streaming API. Coalesces deltas by time and growth, never resends
 * unchanged text, waits out `MessengerRateLimited`, rolls over to a fresh
 * message past `limits.maxText`, and always flushes the tail.
 *
 * The first chunk goes out as soon as any text arrives, so the message shows
 * up immediately and fills in from there. A stream that produced no text
 * posts nothing and yields `None`.
 */
export const streamViaEdits =
  (verbs: EditableVerbs, options?: StreamViaEditsOptions): MessengerService["stream"] =>
  (deltas, streamOptions = {}) =>
    Effect.gen(function* () {
      const every = Duration.toMillis(options?.every ?? "1 second")
      const minChars = options?.minChars ?? 40
      const schedule = honourRetryAfter(options?.rateLimitRetries ?? 3)
      const conversation = yield* CurrentConversation

      const patiently = <A, R2>(
        effect: Effect.Effect<A, MessengerError.MessengerError, R2>,
      ): Effect.Effect<A, MessengerError.MessengerError, R2> =>
        Effect.retry(effect, { schedule, while: isRateLimited })

      // Post a draft, edit a sent message, and skip an edit that would resend
      // what the message already shows.
      const deliver = (
        s: Progress,
        body: string,
        now: number,
      ): Effect.Effect<Sent, MessengerError.MessengerError, CurrentConversation> =>
        Progress.$match(s, {
          Draft: ({ pending, envelope }) =>
            patiently(verbs.post(text(body, envelope))).pipe(
              Effect.map((id) => Progress.Sent({ id, sent: body, pending, lastFlush: now })),
            ),
          Sent: (sent) =>
            body === sent.sent
              ? Effect.succeed(sent)
              : patiently(verbs.edit({ conversation, id: sent.id }, text(body))).pipe(
                  Effect.as(Progress.Sent({ ...sent, sent: body, lastFlush: now })),
                ),
        })

      // Anything past the ceiling becomes the next message: finish the current
      // one at a clean boundary, then start a draft on the remainder.
      const rollover = (
        s: Progress,
        now: number,
      ): Effect.Effect<Progress, MessengerError.MessengerError, CurrentConversation> => {
        const [head, rest] = cutAt(s.pending, verbs.limits.maxText)
        return rest.length === 0
          ? Effect.succeed(s)
          : deliver(s, head, now).pipe(
              Effect.flatMap(() => rollover(Progress.Draft({ pending: rest, envelope: {} }), now)),
            )
      }

      // A draft lands on its first real text; a sent message waits for both
      // gates. Blank is not text: a model that opens a tool-calling turn with
      // a newline would otherwise post it, and platforms reject a message
      // that is only whitespace.
      const due = (s: Progress, now: number): boolean =>
        Progress.$match(s, {
          Draft: ({ pending }) => pending.trim().length > 0,
          Sent: ({ sent, pending, lastFlush }) =>
            now - lastFlush >= every && pending.length - sent.length >= minChars,
        })

      const step = (before: Progress, delta: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const s = yield* rollover(appended(before, delta), now)
          if (!due(s, now)) return s
          return yield* deliver(s, s.pending, now)
        })

      const folded = yield* Stream.runFoldEffect(
        deltas,
        () => Progress.Draft({ pending: "", envelope: streamOptions }),
        step,
      )
      const now = yield* Clock.currentTimeMillis
      const s = yield* rollover(folded, now)
      // The tail always lands; a draft that never held text is nothing to send.
      if (s._tag === "Draft" && s.pending.trim().length === 0) return Option.none()
      const final = yield* deliver(s, s.pending, now)
      return Option.some(final.id)
    })
