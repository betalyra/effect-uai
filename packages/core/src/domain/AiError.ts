import { Data, Duration } from "effect"

export type Scope = "rpm" | "tpm" | "rpd" | "tpd"

export class RateLimited extends Data.TaggedError("RateLimited")<{
  provider: string
  retryAfter?: Duration.Duration
  scope?: Scope
  requestId?: string
  raw: unknown
}> {}

export class Unavailable extends Data.TaggedError("Unavailable")<{
  provider: string
  retryAfter?: Duration.Duration
  status?: number
  requestId?: string
  raw: unknown
}> {}

export class Timeout extends Data.TaggedError("Timeout")<{
  provider: string
  requestId?: string
  raw: unknown
}> {}

export class ContentFiltered extends Data.TaggedError("ContentFiltered")<{
  provider: string
  reason?: string
  requestId?: string
  raw: unknown
}> {}

export class ContextLengthExceeded extends Data.TaggedError("ContextLengthExceeded")<{
  provider: string
  modelLimit?: number
  requested?: number
  raw: unknown
}> {}

export class InvalidRequest extends Data.TaggedError("InvalidRequest")<{
  provider: string
  param?: string
  requestId?: string
  raw: unknown
}> {}

export type AuthSubtype = "auth" | "permission" | "billing" | "quota"

export class AuthFailed extends Data.TaggedError("AuthFailed")<{
  provider: string
  subtype: AuthSubtype
  raw: unknown
}> {}

export class Cancelled extends Data.TaggedError("Cancelled")<{
  provider: string
}> {}

/**
 * The model errored mid-generation. Distinct from `Unavailable` (transport
 * problem before generation started) and from `IncompleteTurn` (provider
 * stream ended without a terminal event). The provider's own error message,
 * if any, is on `message`.
 */
export class GenerationFailed extends Data.TaggedError("GenerationFailed")<{
  provider: string
  code?: string
  message?: string
  requestId?: string
  raw: unknown
}> {}

/**
 * The provider's delta stream ended without a terminal `TurnComplete`.
 * Indicates a misbehaving provider or a connection that dropped mid-flight.
 * Non-terminal deltas seen so far have already been emitted downstream.
 */
export class IncompleteTurn extends Data.TaggedError("IncompleteTurn")<{
  raw?: unknown
}> {}

/**
 * The provider does not implement the requested capability for this
 * specific request. Distinct from `InvalidRequest` (the request shape is
 * malformed) and `AuthFailed` (the request was rejected).
 *
 * Reserved for request-data-dependent gaps where the provider supports
 * the method in general but not for these inputs — e.g. Google's
 * `streamSynthesisFrom` works only for Chirp 3 HD voices; calling it
 * with a Neural2 voice ID fails `Unsupported`.
 *
 * Blanket provider-level gaps (e.g. OpenAI has no incremental-text-in
 * TTS at all) are gated at compile time via capability marker tags
 * (`TtsIncrementalText`, `SttStreaming`) on the R channel instead.
 */
export class Unsupported extends Data.TaggedError("Unsupported")<{
  provider: string
  capability: string
  reason?: string
}> {}

export type AiError =
  | RateLimited
  | Unavailable
  | Timeout
  | ContentFiltered
  | ContextLengthExceeded
  | InvalidRequest
  | AuthFailed
  | Cancelled
  | IncompleteTurn
  | GenerationFailed
  | Unsupported
