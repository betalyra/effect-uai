import { Array as Arr, Effect, Match, Option, Schema, pipe } from "effect"
import * as AiError from "@effect-uai/core/AiError"

export const PROVIDER = "fal"

export const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: PROVIDER, raw: cause })

// ---------------------------------------------------------------------------
// Errors
//
// fal validates request bodies with Pydantic, so a rejected field and a
// refused prompt arrive the same way: 422 with a `detail` array. The entry's
// `type` is what separates them. Errors that carry `detail` as a plain
// string (a missing app, a bad key) fail this decode and fall through to the
// status mapping, which is where they belong.
//
// Reference: https://fal.ai/docs/model-apis/errors
// ---------------------------------------------------------------------------

const Detail = Schema.Struct({
  loc: Schema.optional(Schema.Array(Schema.Unknown)),
  msg: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
})
type Detail = typeof Detail.Type

/** Wrapped in `detail` off the gateway, bare off the runner. */
const WireError = Schema.Union([
  Schema.Struct({ detail: Schema.Array(Detail) }),
  Schema.Array(Detail),
])
type WireError = typeof WireError.Type

const decodeWireError = Schema.decodeUnknownEffect(Schema.fromJsonString(WireError))

const detailsOf = (wire: WireError): ReadonlyArray<Detail> =>
  "detail" in wire ? wire.detail : wire

/** The one refusal `type` fal documents; every other type is a bad field. */
const CONTENT_POLICY = "content_policy_violation"

const refusalOf = (wire: WireError, raw: string): Option.Option<AiError.AiError> =>
  pipe(
    detailsOf(wire),
    Arr.findFirst((detail) => detail.type === CONTENT_POLICY),
    Option.map(
      (detail) =>
        new AiError.ContentFiltered({
          provider: PROVIDER,
          ...(detail.msg !== undefined && { reason: detail.msg }),
          raw,
        }),
    ),
  )

const statusError = (status: number, body: string): AiError.AiError =>
  Match.value(status).pipe(
    Match.when(
      429,
      (): AiError.AiError => new AiError.RateLimited({ provider: PROVIDER, raw: body }),
    ),
    Match.whenOr(
      408,
      504,
      (): AiError.AiError => new AiError.Timeout({ provider: PROVIDER, raw: body }),
    ),
    Match.when(
      401,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: PROVIDER, subtype: "auth", raw: body }),
    ),
    Match.when(
      403,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: PROVIDER, subtype: "permission", raw: body }),
    ),
    Match.when(
      402,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: PROVIDER, subtype: "billing", raw: body }),
    ),
    Match.when(
      413,
      (): AiError.AiError => new AiError.ContextLengthExceeded({ provider: PROVIDER, raw: body }),
    ),
    Match.when(
      (n) => n >= 500,
      (n): AiError.AiError => new AiError.Unavailable({ provider: PROVIDER, status: n, raw: body }),
    ),
    Match.orElse(
      (): AiError.AiError => new AiError.InvalidRequest({ provider: PROVIDER, raw: body }),
    ),
  )

/** Never fails: the returned error is the value. */
export const httpError = (status: number, body: string): Effect.Effect<AiError.AiError> =>
  decodeWireError(body).pipe(
    Effect.map((wire) => Option.getOrElse(refusalOf(wire, body), () => statusError(status, body))),
    Effect.orElseSucceed(() => statusError(status, body)),
  )

// ---------------------------------------------------------------------------
// Reference-field discovery
//
// Endpoints spell the reference field four different ways and the id does
// not say which. Rather than table fal's catalogue, read the answer off
// the endpoint's own validation error: a `missing` entry names the field
// it wanted in `loc`.
// ---------------------------------------------------------------------------

/** `image_url`, `image_urls`, `input_image_urls`, `reference_image_url`, … */
const IMAGE_FIELD = /^[a-z_]*image[a-z_]*_urls?$/

/**
 * The reference field this endpoint asked for, if it rejected the request
 * for want of one. `Effect` only because the decode is; it never fails.
 */
export const missingImageField = (body: string): Effect.Effect<Option.Option<string>> =>
  decodeWireError(body).pipe(
    Effect.map((wire) =>
      pipe(
        detailsOf(wire),
        Arr.filter((detail) => detail.type === "missing"),
        Arr.map((detail) => detail.loc?.[1]),
        Arr.findFirst((name): name is string => typeof name === "string" && IMAGE_FIELD.test(name)),
      ),
    ),
    Effect.orElseSucceed(() => Option.none<string>()),
  )
