import { Array as Arr, Data, Duration, Effect, Redacted, Result, Schema, pipe } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as MessengerError from "@effect-uai/core/MessengerError"
import * as Multipart from "@effect-uai/core/Multipart"

export const provider = "telegram"

export type Config = {
  readonly token: Redacted.Redacted
  /** Defaults to `https://api.telegram.org`. */
  readonly baseUrl?: string
}

/**
 * A Bot API call that came back `ok: false` or never came back at all.
 * `code` mirrors the HTTP status Telegram puts in `error_code`; each verb
 * maps this onto its own `MessengerError`.
 */
export class ApiFailure extends Data.TaggedError("TelegramApiFailure")<{
  readonly method: string
  readonly code?: number
  readonly description: string
  readonly raw: unknown
}> {}

export type ApiError = ApiFailure | MessengerError.MessengerRateLimited

const Envelope = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
  error_code: Schema.optional(Schema.Number),
  parameters: Schema.optional(Schema.Struct({ retry_after: Schema.optional(Schema.Number) })),
})

export type Params = Readonly<Record<string, unknown>>

/** The file part of a multipart upload. */
export type Upload = {
  readonly field: string
  readonly bytes: Uint8Array
  readonly filename: string
  readonly mimeType: string
}

const endpoint = (cfg: Config, method: string): string =>
  `${cfg.baseUrl ?? "https://api.telegram.org"}/bot${Redacted.value(cfg.token)}/${method}`

const transportFailure = (method: string) => (raw: unknown) =>
  new ApiFailure({ method, description: "transport failure", raw })

const rejected = (method: string, envelope: typeof Envelope.Type): ApiError =>
  envelope.parameters?.retry_after !== undefined
    ? new MessengerError.MessengerRateLimited({
        provider,
        retryAfter: Duration.seconds(envelope.parameters.retry_after),
        raw: envelope,
      })
    : new ApiFailure({
        method,
        ...(envelope.error_code !== undefined && { code: envelope.error_code }),
        description: envelope.description ?? "unknown error",
        raw: envelope,
      })

const send = (
  method: string,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<unknown, ApiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(request).pipe(Effect.mapError(transportFailure(method)))
    const json = yield* response.json.pipe(Effect.mapError(transportFailure(method)))
    const envelope = yield* Schema.decodeUnknownEffect(Envelope)(json).pipe(
      Effect.mapError(
        () => new ApiFailure({ method, description: "malformed envelope", raw: json }),
      ),
    )
    return envelope.ok ? envelope.result : yield* rejected(method, envelope)
  })

/** One JSON-bodied method call. `result` comes back undecoded. */
export const call =
  (cfg: Config) =>
  (method: string, params: Params = {}): Effect.Effect<unknown, ApiError, HttpClient.HttpClient> =>
    send(
      method,
      HttpClientRequest.post(endpoint(cfg, method)).pipe(HttpClientRequest.bodyJsonUnsafe(params)),
    )

type Entry = readonly [name: string, value: string | File]

// A `File` carries its own filename, so one entry shape covers both kinds.
const entries = (params: Params, file: Upload): ReadonlyArray<Entry> =>
  pipe(
    Object.entries(params),
    Arr.filterMap(([name, value]) =>
      value === undefined ? Result.failVoid : Result.succeed([name, String(value)] as const),
    ),
    Arr.append([
      file.field,
      new File([file.bytes as Uint8Array<ArrayBuffer>], file.filename, { type: file.mimeType }),
    ] as const),
  )

const formData = (fields: ReadonlyArray<Entry>): FormData =>
  fields.reduce((form, [name, value]) => (form.append(name, value), form), new FormData())

/** One multipart method call: string fields plus a single file part. */
export const upload =
  (cfg: Config) =>
  (
    method: string,
    params: Params,
    file: Upload,
  ): Effect.Effect<unknown, ApiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      const body = yield* Multipart.bodyMultipart(formData(entries(params, file))).pipe(
        Effect.mapError(transportFailure(method)),
      )
      return yield* send(method, HttpClientRequest.post(endpoint(cfg, method)).pipe(body))
    })

/** Decode a call's `result`; a shape mismatch is a malformed response, not a defect. */
export const decoded =
  <A>(method: string, schema: Schema.Decoder<A>) =>
  <E, R>(result: Effect.Effect<unknown, E, R>): Effect.Effect<A, E | ApiFailure, R> =>
    Effect.gen(function* () {
      const raw = yield* result
      return yield* Schema.decodeUnknownEffect(schema)(raw).pipe(
        Effect.mapError(() => new ApiFailure({ method, description: "malformed result", raw })),
      )
    })
