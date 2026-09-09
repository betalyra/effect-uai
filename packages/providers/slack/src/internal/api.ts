import { Data, Duration, Effect, Option, Redacted, Schema } from "effect"
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http"
import * as MessengerError from "@effect-uai/core/MessengerError"

export const provider = "slack"

export type Config = {
  /** `xoxb-`, for every Web API call. */
  readonly botToken: Redacted.Redacted
  /** `xapp-`, for `apps.connections.open` and nothing else. */
  readonly appToken: Redacted.Redacted
  /** Defaults to `https://slack.com/api`. */
  readonly baseUrl?: string
}

/**
 * A Web API call that came back `ok: false` or never came back at all.
 * `error` is Slack's own error string (`channel_not_found`, `invalid_auth`);
 * each verb maps this onto its own `MessengerError`.
 */
export class ApiFailure extends Data.TaggedError("SlackApiFailure")<{
  readonly method: string
  readonly status?: number
  readonly error: string
  readonly raw: unknown
}> {}

export type ApiError = ApiFailure | MessengerError.MessengerRateLimited

// Slack answers every method with `ok`, then the result fields beside it.
const Envelope = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
})

export type Params = Readonly<Record<string, unknown>>

/** The bytes behind a `files.getUploadURLExternal` URL. */
export type Upload = {
  readonly bytes: Uint8Array
  readonly filename: string
  readonly mimeType: string
}

const endpoint = (cfg: Config, method: string): string =>
  `${cfg.baseUrl ?? "https://slack.com/api"}/${method}`

const authorized = (
  request: HttpClientRequest.HttpClientRequest,
  token: Redacted.Redacted,
): HttpClientRequest.HttpClientRequest =>
  HttpClientRequest.setHeader(request, "Authorization", `Bearer ${Redacted.value(token)}`)

const transportFailure = (method: string) => (raw: unknown) =>
  new ApiFailure({ method, error: "transport failure", raw })

// A 429 carries the wait in a header rather than the body, and Slack's own
// floor for a missing one is a minute.
const retryAfter = (headers: Headers.Headers): Duration.Duration =>
  Headers.get(headers, "retry-after").pipe(
    Option.map(Number),
    Option.filter(Number.isFinite),
    Option.getOrElse(() => 60),
    Duration.seconds,
  )

const send = (
  method: string,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<unknown, ApiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(request).pipe(Effect.mapError(transportFailure(method)))
    if (response.status === 429) {
      return yield* new MessengerError.MessengerRateLimited({
        provider,
        retryAfter: retryAfter(response.headers),
      })
    }
    const body = yield* response.json.pipe(Effect.mapError(transportFailure(method)))
    const envelope = yield* Schema.decodeUnknownEffect(Envelope)(body).pipe(
      Effect.mapError(() => new ApiFailure({ method, error: "malformed envelope", raw: body })),
    )
    // The result fields sit beside `ok`, so the whole body is the result.
    return envelope.ok
      ? body
      : yield* new ApiFailure({
          method,
          status: response.status,
          error: envelope.error ?? "unknown error",
          raw: body,
        })
  })

const post = (cfg: Config, method: string, params: Params | undefined) => {
  const request = HttpClientRequest.post(endpoint(cfg, method))
  // A method with no arguments takes no body at all; Slack rejects an empty one.
  return params === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, params)
}

/** One JSON method call with the bot token. The body comes back undecoded. */
export const call =
  (cfg: Config) =>
  (method: string, params?: Params): Effect.Effect<unknown, ApiError, HttpClient.HttpClient> =>
    send(method, authorized(post(cfg, method, params), cfg.botToken))

/** `apps.connections.open`, the only call the app token is for. */
export const callAsApp =
  (cfg: Config) =>
  (method: string): Effect.Effect<unknown, ApiError, HttpClient.HttpClient> =>
    send(method, authorized(post(cfg, method, undefined), cfg.appToken))

/** One method called with query parameters, for the few that take no JSON body. */
export const query =
  (cfg: Config) =>
  (method: string, params: Params): Effect.Effect<unknown, ApiError, HttpClient.HttpClient> =>
    send(
      method,
      authorized(
        HttpClientRequest.get(endpoint(cfg, method)).pipe(
          HttpClientRequest.setUrlParams(
            Object.entries(params).map(([name, value]) => [name, String(value)] as const),
          ),
        ),
        cfg.botToken,
      ),
    )

const uploadRejected = (response: HttpClientResponse.HttpClientResponse) =>
  new ApiFailure({
    method: "files.upload",
    status: response.status,
    error: `upload rejected with HTTP ${response.status}`,
    raw: response.status,
  })

/**
 * Raw bytes to the URL `files.getUploadURLExternal` handed out. Not a Web API
 * call: no token, no `ok` envelope, and the response body is plain text.
 */
export const upload = (
  url: string,
  file: Upload,
): Effect.Effect<void, ApiFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyUint8Array(file.bytes as Uint8Array<ArrayBuffer>, file.mimeType),
        ),
      )
      .pipe(Effect.mapError(transportFailure("files.upload")))
    if (response.status >= 400) return yield* uploadRejected(response)
  })

/** Decode a response body; a shape mismatch is a malformed response, not a defect. */
export const decoded =
  <A>(method: string, schema: Schema.Decoder<A>) =>
  <E, R>(result: Effect.Effect<unknown, E, R>): Effect.Effect<A, E | ApiFailure, R> =>
    Effect.gen(function* () {
      const raw = yield* result
      return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
        Effect.mapError(() => new ApiFailure({ method, error: "malformed response", raw })),
      )
    })
