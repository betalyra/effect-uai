import { Context, Effect, Stream } from "effect";
import * as AiError from "../domain/AiError.js";
import type { Item } from "../domain/Items.js";
import type * as StructuredFormat from "../structured-format/StructuredFormat.js";
import type { ToolDescriptor } from "../tool/Tool.js";
import { isTurnComplete, type Turn, type TurnEvent } from "../domain/Turn.js";

/**
 * Cross-provider request shape. Every call carries its own `history` and
 * `model` - models are not bound at layer construction. Anything specific
 * to a single provider (reasoning effort, prompt caching, store flags,
 * ...) lives in that provider's own request interface, which extends this.
 */
export interface CommonRequest {
  readonly history: ReadonlyArray<Item>;
  /**
   * Model identifier. Each provider narrows this to its typed literal union,
   * so code that yields a typed provider tag gets autocompletion.
   */
  readonly model: string;
  readonly tools?: ReadonlyArray<ToolDescriptor>;
  readonly toolChoice?:
    | "auto"
    | "required"
    | "none"
    | { readonly type: "function"; readonly name: string };
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
  /**
   * Schema-bound JSON output. The provider constrains the wire to match the
   * schema; pair with `Turn.toStructured` for runtime validation. Supported
   * across all current providers (OpenAI Responses json_schema, Anthropic
   * `output_config`, Gemini `responseJsonSchema`).
   */
  readonly structured?: StructuredFormat.StructuredFormat<unknown>;
}

export interface LanguageModelService {
  readonly streamTurn: (
    request: CommonRequest,
  ) => Stream.Stream<TurnEvent, AiError.AiError>;
}

export class LanguageModel extends Context.Service<
  LanguageModel,
  LanguageModelService
>()("@betalyra/effect-uai/LanguageModel") {}

/**
 * Stream the deltas of a single turn.
 */
export const streamTurn = (
  request: CommonRequest,
): Stream.Stream<TurnEvent, AiError.AiError, LanguageModel> =>
  Stream.unwrap(
    Effect.map(LanguageModel.asEffect(), (m) => m.streamTurn(request)),
  );
