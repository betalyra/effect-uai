import { Match } from "effect"
import * as AiError from "@effect-uai/core/AiError"

/** Map an HTTP status from any Mistral endpoint to an `AiError` variant. */
export const httpStatusError: (status: number, body: string) => AiError.AiError = (status, body) =>
  Match.value(status).pipe(
    Match.when(429, (): AiError.AiError => new AiError.RateLimited({ provider: "mistral", raw: body })),
    Match.whenOr(
      408,
      504,
      (): AiError.AiError => new AiError.Timeout({ provider: "mistral", raw: body }),
    ),
    Match.when(
      401,
      (): AiError.AiError => new AiError.AuthFailed({ provider: "mistral", subtype: "auth", raw: body }),
    ),
    Match.when(
      403,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "mistral", subtype: "permission", raw: body }),
    ),
    Match.when(
      402,
      (): AiError.AiError =>
        new AiError.AuthFailed({ provider: "mistral", subtype: "billing", raw: body }),
    ),
    Match.when(
      413,
      (): AiError.AiError => new AiError.ContextLengthExceeded({ provider: "mistral", raw: body }),
    ),
    Match.when(
      (n) => n >= 500,
      (n): AiError.AiError => new AiError.Unavailable({ provider: "mistral", status: n, raw: body }),
    ),
    Match.orElse((): AiError.AiError => new AiError.InvalidRequest({ provider: "mistral", raw: body })),
  )

export const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "mistral", raw: cause })
