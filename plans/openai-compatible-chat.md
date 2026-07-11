# Plan: OpenAI-compatible Chat Completions `LanguageModel` base

## What this is

A shared, reusable `LanguageModel` implementation for the **OpenAI Chat
Completions** wire dialect (`POST /chat/completions`, `messages[]` in,
`choices[].message` / `choices[].delta` out, `data: [DONE]` SSE terminator).
This is the *old* OpenAI API, distinct from the Responses API (`/v1/responses`,
the `@effect-uai/responses` package). A large set of providers are drop-in
compatible with it and differ only in base URL, auth header, model ids, and a
handful of extra request/response fields:

- OpenRouter, Together, Groq, Fireworks, DeepSeek, Perplexity (sync sonar),
  xAI (chat-completions surface), Nebius, and most "OpenAI-compatible" gateways.

## Why now

We currently implement this dialect **once, inlined in `@effect-uai/mistral`**
([mistral/src/Mistral.ts](../packages/providers/mistral/src/Mistral.ts) +
`codec.ts` + `http.ts`): request framing (`itemsToMessages`, `toolsWire`,
`toolChoiceWire`, `responseFormatWire`), SSE decode (`decodeChunk`,
`applyChunk`, `accumulatorToTurn`), and the `TurnEvent` streaming. Adding
Perplexity's sync LanguageModel (and any of the providers above) would copy that
codec verbatim. That is the duplication this plan removes.

## Shape

A base module (working name `@effect-uai/openai-compatible`, or a
`chat-completions` module in `core`) exposing:

```ts
export type ChatConfig = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl: string                 // provider-specific
  readonly provider: string                // for AiError tagging
  readonly authHeader?: (key: string) => readonly [name: string, value: string]  // default: Authorization: Bearer
  readonly path?: string                    // default "/chat/completions"
  /** Provider-specific request fields merged into the wire body. */
  readonly extraBody?: (request: CommonRequest) => Record<string, unknown>
  /** Provider-specific response enrichment, e.g. Perplexity search_results -> annotations. */
  readonly decorateTurn?: (turn: Turn, raw: unknown) => Turn
}

export const make: (cfg: ChatConfig) => Effect<LanguageModelService, never, HttpClient>
export const layer: (tag, cfg: ChatConfig) => Layer<... | LanguageModel, never, HttpClient>
```

Each provider package becomes thin: a typed request (narrowing `model` to its
literal union plus its own knobs), a `Config`, and a `layer` that calls the base
`make`/`layer` with its `baseUrl` / `authHeader` / `extraBody` / `decorateTurn`.

## Migration

1. Extract the Mistral chat-completions codec + stream plumbing into the base,
   generalized over `ChatConfig`. Keep the codec behavior identical (the
   existing `mistral/src/codec.test.ts` is the regression guard).
2. Reimplement `@effect-uai/mistral` on top of the base (its `safePrompt` /
   `randomSeed` become `extraBody`). Prove parity via the existing tests.
3. Add new providers as thin configs: **Perplexity sync sonar** (LanguageModel;
   `search_results` -> `Items.Annotation` via `decorateTurn`, the citation
   payoff on the LM path), **OpenRouter**, **Together**, **Groq**, etc.

## Notes / open questions

- **Citations.** Chat Completions has no streamed-annotation events (unlike
  Responses). Providers that ground (Perplexity, OpenRouter with web plugins)
  bundle sources in the final payload, so `decorateTurn` attaches them to the
  assembled `Turn`'s `OutputText.annotations` (surfaced via `Turn.citations`),
  not as streamed `CitationAdded`. Consistent with the citation model in
  `deep-research.md` Appendix A.
- **Package vs core module.** A standalone `@effect-uai/openai-compatible`
  package that provider packages depend on, vs a shared module in `core`. Lean
  package, so `core` stays wire-agnostic. Decide before extraction.
- **Tool calling.** Chat Completions `tools` / `tool_calls` shape is uniform
  across these providers; reuse Mistral's mapping unchanged.
- Relationship to Responses: these are two different wire dialects. This base is
  Chat Completions only; do not fold in Responses.
