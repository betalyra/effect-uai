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
 * The provider's delta stream ended without a terminal `turn_complete`.
 * Indicates a misbehaving provider or a connection that dropped mid-flight.
 * Non-terminal deltas seen so far have already been emitted downstream.
 */
export class IncompleteTurn extends Data.TaggedError("IncompleteTurn")<{
  raw?: unknown
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
