import { Effect, Match, Option, Redacted, Schema, pipe } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Job from "@effect-uai/core/Job"
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

const REQUESTS = "/requests/"
const RESPONSE_URL = /^https?:\/\/[^/]+\/(.+)\/requests\/[^/]+$/
const REF = /^(.+)\/([^/]+)$/

const first = (match: RegExpExecArray | null): Option.Option<string> =>
  pipe(
    Option.fromNullOr(match),
    Option.flatMap(([, group]) => (group === undefined ? Option.none() : Option.some(group))),
  )

/** The endpoint id is the fallback for a `response_url` shaped unexpectedly. */
const appOf = (responseUrl: string, endpoint: string): string =>
  Option.getOrElse(first(RESPONSE_URL.exec(responseUrl)), () => endpoint)

const splitRef = (id: string): Option.Option<readonly [string, string]> =>
  pipe(
    Option.fromNullOr(REF.exec(id)),
    Option.flatMap(([, app, requestId]) =>
      app !== undefined && requestId !== undefined
        ? Option.some([app, requestId] as const)
        : Option.none(),
    ),
  )

/** `{base}/{app}/requests/{id}`, the prefix status, result and cancel share. */
const urlOf = (cfg: Config, ref: Job.JobRef<string>): Effect.Effect<string, AiError.AiError> =>
  Option.match(splitRef(ref.id), {
    onNone: () =>
      Effect.fail(
        new AiError.InvalidRequest({
          provider: PROVIDER,
          param: "ref",
          raw: `"${ref.id}" is not a fal queue reference.`,
        }),
      ),
    onSome: ([app, requestId]) => Effect.succeed(`${host(cfg)}/${app}${REQUESTS}${requestId}`),
  })

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

/** The ref a submission earned, or the rejection it earned instead. */
export const accept = (
  endpoint: string,
  raw: Raw,
): Effect.Effect<Job.JobRef<string>, AiError.AiError> =>
  raw.status >= 400
    ? rejected(raw)
    : Effect.map(readBody(decodeSubmitted, raw, "queue submission"), (wire) =>
        Job.jobRef<string>(PROVIDER, `${appOf(wire.response_url, endpoint)}/${wire.request_id}`),
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
 * both the output and the failure.
 */
const settled = (
  cfg: Config,
  ref: Job.JobRef<string>,
  url: string,
): Effect.Effect<Job.JobState<string>, AiError.AiError, HttpClient.HttpClient> =>
  Effect.map(send(cfg, HttpClientRequest.get(url)), (raw) =>
    raw.status >= 400
      ? Job.JobState.Failed({ reason: `fal returned ${raw.status} for ${ref.id}.`, raw: raw.body })
      : Job.JobState.Succeeded({ result: raw.body }),
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
      Match.orElse(() => settled(cfg, ref, url)),
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
