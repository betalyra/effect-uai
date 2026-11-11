import { Array as Arr, Effect, Match, Option, Redacted, Schema, pipe } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Job from "@effect-uai/core/Job"
import * as Retry from "@effect-uai/core/Retry"
import { PROVIDER, httpError, transportFailure } from "./codec.js"

/**
 * fal's queue API: submit returns immediately with a request id and the run
 * is polled from there. Every video endpoint is served here; the synchronous
 * `fal.run` host the image adapter uses has no queue behind it and no way to
 * outlive a connection.
 *
 * Reference: https://fal.ai/docs/model-endpoints/queue
 */
export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

const host = (cfg: Config): string => cfg.baseUrl ?? "https://queue.fal.run"

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Status kept alongside the body rather than thrown, so a 4xx keeps its payload. */
export type Raw = {
  readonly status: number
  readonly body: string
}

const send = (
  cfg: Config,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<Raw, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(
        HttpClientRequest.setHeader(request, "authorization", `Key ${Redacted.value(cfg.apiKey)}`),
      )
      .pipe(Effect.mapError(transportFailure))
    const body = yield* response.text.pipe(Effect.mapError(transportFailure))
    return { status: response.status, body }
  })

const rejected = (raw: Raw): Effect.Effect<never, AiError.AiError> =>
  Effect.flatMap(httpError(raw.status, raw.body), Effect.fail)

const readBody = <A, E>(
  decode: (input: unknown) => Effect.Effect<A, E>,
  raw: Raw,
  what: string,
): Effect.Effect<A, AiError.AiError> =>
  decode(raw.body).pipe(
    Effect.mapError(
      () =>
        new AiError.GenerationFailed({
          provider: PROVIDER,
          message: `fal returned an unreadable ${what}.`,
          raw: raw.body,
        }),
    ),
  )

// ---------------------------------------------------------------------------
// References
//
// A ref's id is `{app}/{requestId}`. The app is not the endpoint: a
// submission to `fal-ai/flux/dev` is polled under `fal-ai/flux`, and how
// many trailing segments drop is per model. `response_url` is fal's own
// answer, so the app is read back off it rather than guessed.
// ---------------------------------------------------------------------------

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)

const nonEmpty = (segments: ReadonlyArray<string>): Option.Option<string> =>
  segments.length === 0 ? Option.none() : Option.some(segments.join("/"))

/** The app in `https://queue.fal.run/{app}/requests/{id}`: every segment before `requests`. */
export const appOf = (responseUrl: string): Option.Option<string> =>
  pipe(
    decodeUrl(responseUrl),
    Option.map((url) => url.pathname.split("/").filter((segment) => segment.length > 0)),
    Option.flatMap((segments) =>
      Option.flatMap(
        Arr.findLastIndex(segments, (s) => s === "requests"),
        (i) => nonEmpty(segments.slice(0, i)),
      ),
    ),
  )

/** `{app}/{requestId}` split at its last segment. */
const splitRef = (id: string): Option.Option<readonly [string, string]> => {
  const segments = id.split("/")
  return Option.flatMap(Arr.last(segments), (requestId) =>
    Option.map(nonEmpty(segments.slice(0, -1)), (app) => [app, requestId] as const),
  )
}

/** `{base}/{app}/requests/{id}`, the prefix status, result and cancel share. */
const urlOf = (cfg: Config, ref: Job.JobRef<string>): Effect.Effect<string, AiError.AiError> =>
  Effect.flatMap(Job.own(PROVIDER)(ref), (own) =>
    Option.match(splitRef(own.id), {
      onNone: () =>
        Effect.fail(
          new AiError.InvalidRequest({
            provider: PROVIDER,
            param: "ref",
            raw: `"${own.id}" is not a fal queue reference.`,
          }),
        ),
      onSome: ([app, requestId]) => Effect.succeed(`${host(cfg)}/${app}/requests/${requestId}`),
    }),
  )

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

const Submitted = Schema.Struct({
  request_id: Schema.String,
  response_url: Schema.String,
})

const decodeSubmitted = Schema.decodeUnknownEffect(Schema.fromJsonString(Submitted))

/**
 * POST the model input. Hands back the raw response so a caller can read a
 * validation rejection and decide whether to correct and resubmit; pass it
 * to {@link accept} once it is final.
 */
export const enqueue = (
  cfg: Config,
  endpoint: string,
  input: Record<string, unknown>,
): Effect.Effect<Raw, AiError.AiError, HttpClient.HttpClient> =>
  send(
    cfg,
    HttpClientRequest.post(`${host(cfg)}/${endpoint}`).pipe(
      HttpClientRequest.bodyJsonUnsafe(input),
    ),
  )

/**
 * The ref a submission earned, or the rejection it earned instead. A
 * `response_url` we cannot read fails here: guessing the app would only
 * turn every later poll into a 404.
 */
export const accept = (raw: Raw): Effect.Effect<Job.JobRef<string>, AiError.AiError> =>
  raw.status >= 400
    ? rejected(raw)
    : Effect.flatMap(readBody(decodeSubmitted, raw, "queue submission"), (wire) =>
        Option.match(appOf(wire.response_url), {
          onNone: () =>
            Effect.fail(
              new AiError.GenerationFailed({
                provider: PROVIDER,
                message: `fal accepted ${wire.request_id} but its response_url names no queue app.`,
                raw: raw.body,
              }),
            ),
          onSome: (app) =>
            Effect.succeed(Job.jobRef<string>(PROVIDER, `${app}/${wire.request_id}`)),
        }),
      )

const Status = Schema.Struct({
  status: Schema.String,
  queue_position: Schema.optional(Schema.NullOr(Schema.Number)),
})

const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(Status))

const queued = (position: number | null | undefined): Job.JobState<string> =>
  Job.JobState.Pending(position == null ? {} : { queuePosition: position })

/**
 * The finished run as its raw output body. fal splits status from result: a
 * settled request says only that it settled, and the result endpoint holds
 * both the output and the failure. A transient error on that fetch fails the
 * poll, so the next one can still collect the result; anything else is the
 * run's own failure, classified (a refusal is `ContentFiltered`).
 */
const settled = (
  cfg: Config,
  url: string,
): Effect.Effect<Job.JobState<string>, AiError.AiError, HttpClient.HttpClient> =>
  Effect.flatMap(
    send(cfg, HttpClientRequest.get(url)),
    (raw): Effect.Effect<Job.JobState<string>, AiError.AiError> =>
      raw.status >= 400
        ? Effect.flatMap(httpError(raw.status, raw.body), (error) =>
            Retry.isRetryable(error)
              ? Effect.fail(error)
              : Effect.succeed(Job.JobState.Failed({ error })),
          )
        : Effect.succeed(Job.JobState.Succeeded({ result: raw.body })),
  )

/**
 * One status fetch, mapped onto {@link Job.JobState}. Settling costs a second
 * call for the result body, which is where fal keeps it.
 *
 * `IN_QUEUE` and `IN_PROGRESS` are the only non-terminal states fal
 * documents, so everything else resolves against the result endpoint rather
 * than a terminal list that a newly added state would fall through.
 */
export const status = (
  cfg: Config,
  ref: Job.JobRef<string>,
): Effect.Effect<Job.JobState<string>, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = yield* urlOf(cfg, ref)
    const raw = yield* send(cfg, HttpClientRequest.get(`${url}/status`))
    if (raw.status >= 400) return yield* rejected(raw)
    const wire = yield* readBody(decodeStatus, raw, "queue status")
    return yield* Match.value(wire.status).pipe(
      Match.when("IN_QUEUE", () => Effect.succeed(queued(wire.queue_position))),
      Match.when("IN_PROGRESS", () => Effect.succeed(Job.JobState.Running())),
      Match.orElse(() => settled(cfg, url)),
    )
  })

/** fal answers `400` once a run has settled, which cancel cannot undo. */
export const cancel = (
  cfg: Config,
  ref: Job.JobRef<string>,
): Effect.Effect<void, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = yield* urlOf(cfg, ref)
    const raw = yield* send(cfg, HttpClientRequest.put(`${url}/cancel`))
    return yield* raw.status >= 400 ? rejected(raw) : Effect.void
  })
