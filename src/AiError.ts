import { Schema } from "effect"

export class AiError extends Schema.ErrorClass<AiError>("effect-ai/AiError")({
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown)
}) {}
