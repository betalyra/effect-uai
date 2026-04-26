import { Schema } from "effect"

export class AiError extends Schema.TaggedErrorClass<AiError>(
  "@betalyra/effect-uai/AiError"
)("AiError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}
