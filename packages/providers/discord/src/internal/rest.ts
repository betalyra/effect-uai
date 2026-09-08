import { Data, Duration, Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as MessengerError from "@effect-uai/core/MessengerError"
import * as Multipart from "@effect-uai/core/Multipart"

export const provider = "discord"

/** Tracks the package version; Discord requires a `DiscordBot (url, version)` agent. */
const userAgent = "DiscordBot (https://effect-uai.betalyra.com, 0.14.0)"

export type Config = {
  readonly token: Redacted.Redacted
  /** Defaults to `https://discord.com/api/v10`. Always version-pinned. */
  readonly baseUrl?: string
}

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"

/** JSON body fields of a request. */
export type Fields = Readonly<Record<string, unknown>>

/**
 * A REST call that came back non-2xx or never came back at all. `code` is
 * Discord's own JSON error code, `status` the HTTP one; each verb maps this
 * onto its own `MessengerError`.
 */
export class ApiFailure extends Data.TaggedError("DiscordApiFailure")<{
  readonly route: string
  readonly status?: number
  readonly code?: number
  readonly message: string
  readonly raw: unknown
}> {}

export type ApiError = ApiFailure | MessengerError.MessengerRateLimited

const ErrorBody = Schema.Struct({
  message: Schema.optional(Schema.String),
  code: Schema.optional(Schema.Number),
  retry_after: Schema.optional(Schema.Number),
})

/** The file part of a multipart message. Discord names it `files[n]`. */
export type Upload = {
  readonly bytes: Uint8Array
  readonly filename: string
  readonly mimeType: string
}

const endpoint = (cfg: Config, path: string): string =>
  `${cfg.baseUrl ?? "https://discord.com/api/v10"}${path}`

const constructors: Record<Method, (url: string) => HttpClientRequest.HttpClientRequest> = {
  GET: HttpClientRequest.get,
  POST: HttpClientRequest.post,
  PATCH: HttpClientRequest.patch,
  PUT: HttpClientRequest.put,
  DELETE: HttpClientRequest.delete,
}

const request = (cfg: Config, method: Method, path: string) =>
  constructors[method](endpoint(cfg, path)).pipe(
    HttpClientRequest.setHeaders({
      Authorization: `Bot ${Redacted.value(cfg.token)}`,
      "User-Agent": userAgent,
    }),
  )

const transportFailure = (route: string) => (raw: unknown) =>
  new ApiFailure({ route, message: "transport failure", raw })

const rejected = (route: string, status: number, raw: unknown): Effect.Effect<never, ApiError> =>
  Effect.gen(function* () {
    const body = yield* Schema.decodeUnknownEffect(ErrorBody)(raw).pipe(
      Effect.orElseSucceed((): typeof ErrorBody.Type => ({})),
    )
    // Discord's `retry_after` is float seconds; only a 429 carries one.
    return yield* status === 429 && body.retry_after !== undefined
      ? new MessengerError.MessengerRateLimited({
          provider,
          retryAfter: Duration.seconds(body.retry_after),
          raw,
        })
      : new ApiFailure({
          route,
          status,
          ...(body.code !== undefined && { code: body.code }),
          message: body.message ?? `HTTP ${status}`,
          raw,
        })
  })

const send = (
  route: string,
  httpRequest: HttpClientRequest.HttpClientRequest,
): Effect.Effect<unknown, ApiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(httpRequest)
      .pipe(Effect.mapError(transportFailure(route)))
    // 204 is the success shape of `typing`, `react` and every delete: no body
    // to read, and reading one would fail.
    if (response.status === 204) return undefined
    const body = yield* response.json.pipe(Effect.mapError(transportFailure(route)))
    return response.status < 400 ? body : yield* rejected(route, response.status, body)
  })

/** One JSON call against the API base. The response body comes back undecoded. */
export const call =
  (cfg: Config) =>
  (
    method: Method,
    path: string,
    body?: unknown,
  ): Effect.Effect<unknown, ApiError, HttpClient.HttpClient> =>
    send(
      `${method} ${path}`,
      body === undefined
        ? request(cfg, method, path)
        : request(cfg, method, path).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
    )

// The `attachments` entry is what binds `files[0]` to the message; without it
// Discord can drop the part and reject the rest as an empty message.
const formData = (payload: Fields, file: Upload): FormData => {
  const form = new FormData()
  form.append(
    "payload_json",
    JSON.stringify({ ...payload, attachments: [{ id: 0, filename: file.filename }] }),
  )
  form.append(
    "files[0]",
    new File([file.bytes as Uint8Array<ArrayBuffer>], file.filename, { type: file.mimeType }),
  )
  return form
}

/** One multipart message: the JSON fields as `payload_json` plus a single file. */
export const upload =
  (cfg: Config) =>
  (
    path: string,
    payload: Fields,
    file: Upload,
  ): Effect.Effect<unknown, ApiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const route = `POST ${path}`
      const body = yield* Multipart.bodyMultipart(formData(payload, file)).pipe(
        Effect.mapError(transportFailure(route)),
      )
      return yield* send(route, request(cfg, "POST", path).pipe(body))
    })

/** Decode a response body; a shape mismatch is a malformed response, not a defect. */
export const decoded =
  <A>(route: string, schema: Schema.Decoder<A>) =>
  <E, R>(result: Effect.Effect<unknown, E, R>): Effect.Effect<A, E | ApiFailure, R> =>
    Effect.gen(function* () {
      const raw = yield* result
      return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
        Effect.mapError(() => new ApiFailure({ route, message: "malformed response", raw })),
      )
    })
