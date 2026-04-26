import { Schema } from "effect"

export class AiError extends Schema.TaggedErrorClass<AiError>(
  "effect-ai/AiError"
)("AiError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}
