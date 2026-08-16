import { Match } from "effect"
import * as AiError from "@effect-uai/core/AiError"

/** Map an HTTP status from a chat-completions endpoint to an `AiError` variant. */
export const httpStatusError = (provider: string, status: number, body: string): AiError.AiError =>
  Match.value(status).pipe(
    Match.when(429, (): AiError.AiError => new AiError.RateLimited({ provider, raw: body })),
    Match.whenOr(408, 504, (): AiError.AiError => new AiError.Timeout({ provider, raw: body })),
    Match.when(
      401,
      (): AiError.AiError => new AiError.AuthFailed({ provider, subtype: "auth", raw: body }),
    ),
    Match.when(
      403,
      (): AiError.AiError => new AiError.AuthFailed({ provider, subtype: "permission", raw: body }),
    ),
    Match.when(
      402,
      (): AiError.AiError => new AiError.AuthFailed({ provider, subtype: "billing", raw: body }),
    ),
    Match.when(
      413,
      (): AiError.AiError => new AiError.ContextLengthExceeded({ provider, raw: body }),
    ),
    Match.when(
      (n) => n >= 500,
      (n): AiError.AiError => new AiError.Unavailable({ provider, status: n, raw: body }),
    ),
    Match.orElse((): AiError.AiError => new AiError.InvalidRequest({ provider, raw: body })),
  )

export const transportFailure = (provider: string, cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider, raw: cause })
