import * as AiError from "@effect-uai/core/AiError"

const provider = "perplexity"

/** Transport-level failure (connection dropped, DNS, etc.) before a response. */
export const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider, raw: cause })

/** Map a >=400 HTTP status to the nearest `AiError`. */
export const httpStatusError = (status: number, body: string): AiError.AiError => {
  const raw = body
  if (status === 429) return new AiError.RateLimited({ provider, raw })
  if (status === 408 || status === 504) return new AiError.Timeout({ provider, raw })
  if (status === 401) return new AiError.AuthFailed({ provider, subtype: "auth", raw })
  if (status === 403) return new AiError.AuthFailed({ provider, subtype: "permission", raw })
  if (status === 402) return new AiError.AuthFailed({ provider, subtype: "billing", raw })
  if (status >= 500) return new AiError.Unavailable({ provider, status, raw })
  return new AiError.InvalidRequest({ provider, raw })
}
