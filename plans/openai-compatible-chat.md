# Plan: OpenAI-compatible Chat Completions `LanguageModel` base

Revised 2026-07-15 against four research reports in [research/](./research/):
[openrouter.md](./research/openrouter.md), [requesty.md](./research/requesty.md),
[jina-mistral.md](./research/jina-mistral.md), [repo-audit.md](./research/repo-audit.md).

## What this is

A shared, reusable `LanguageModel` implementation for the **OpenAI Chat
Completions** wire dialect (`POST /chat/completions`, `messages[]` in,
`choices[].message` / `choices[].delta` out, `data: [DONE]` SSE terminator).
This is the _old_ OpenAI API, distinct from the Responses API (`/v1/responses`,
the `@effect-uai/responses` package).

Target consumers, in priority order: **Mistral** (today's sole implementation),
**OpenRouter**, **Requesty**, **Jina DeepSearch**, **Perplexity sync sonar**.

## Headline findings that changed this plan

1. **Both routers do support the Responses API**, but neither is a reason to skip
   this work. OpenRouter's `/api/v1/responses` is **beta with breaking changes
   expected**, and `provider` routing (its entire value proposition) is
   undocumented there. Requesty's `/v1/responses` is documented and non-beta, but
   its standard `openai/` prefix **routes through Chat Completions under the
   hood** anyway. See "Responses vs Chat Completions" below for the decision.
2. **Statelessness is a non-issue for us.** Both routers lack
   `previous_response_id`. Our core `CommonRequest` carries full `history` and
   every provider resends it, so we never depended on server-side state. This
   removes the obvious objection to reusing `responses` for the routers later.
3. **"OpenAI-compatible" is thinner than the original plan assumed.** Mistral
   rejects `max_completion_tokens` with 422 and validates strictly; Jina emits
   camelCase citations, inlines reasoning in `<think>` tags, and supports no tool
   calling at all; OpenRouter injects `: OPENROUTER PROCESSING` SSE comments and
   reports mid-stream errors under HTTP 200. A single `ChatConfig` with four
   hooks will not absorb this. The shape below is revised accordingly.
4. **Mistral's 9-character tool-call-id constraint is a latent bug in our
   codec today.** `^[a-zA-Z0-9]{9}$` is enforced on `tool_call_id` when replaying
   history, and our fallback id is `` `call_${index}` `` ([mistral/src/codec.ts:261](../packages/providers/mistral/src/codec.ts#L261)),
   which has an underscore and the wrong length. It also breaks the
   multi-model-fallback recipe: Anthropic `toolu_…` and OpenAI `call_…` ids are
   rejected outright when replayed into Mistral.
5. **Perplexity already carries most of a chat-completions codec** in
   [PerplexityDeepResearch.ts](../packages/providers/perplexity/src/PerplexityDeepResearch.ts)
   (`WireChoice`/`WireUsage`/`WireCompletion`, `historyToMessages`,
   `completionToTurn`, citation→`Annotation`), and its `models.ts` already types
   `sonar`/`sonar-pro` for "the sync chat endpoint" that doesn't exist yet.

## Responses vs Chat Completions for the routers

**Decision: ship OpenRouter and Requesty on Chat Completions. Defer the Responses
dialect.**

|                                   | OpenRouter                                               | Requesty                                                                |
| --------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Chat Completions                  | `https://openrouter.ai/api/v1` (note `/api/v1`)          | `https://router.requesty.ai/v1`, EU: `https://router.eu.requesty.ai/v1` |
| Responses                         | `/api/v1/responses`, **beta, breaking changes expected** | `/v1/responses`, documented, non-beta                                   |
| Stateful (`previous_response_id`) | No                                                       | No (absent from docs and OpenAPI spec)                                  |
| Router features on Responses      | `plugins` confirmed; **`provider` routing unconfirmed**  | `requesty` object + `policy/` prefix work (model-name-level)            |

Rationale:

- Chat Completions is the mature, fully documented surface on both, and it is
  where the router-specific features that justify using a router at all live
  (OpenRouter `provider` routing / `models[]` fallback; Requesty policies).
- On Requesty, `openai/gpt-5` against `/v1/responses` is a translation shim back
  to Chat Completions. Going Responses→Requesty→Chat Completions adds a
  translation layer for no gain unless the caller uses the `openai-responses/`
  prefix specifically.
- We need the Chat Completions base regardless, for Mistral, Jina, and Perplexity.
  Building it serves five consumers; a router-Responses path serves two and
  duplicates a surface we already have.

Revisit when OpenRouter's Responses leaves beta. The work is then small and
independently valuable (it is the same parameterization Azure needs), so it is
kept as Phase 6 rather than dropped.

## Shape

The original single-`ChatConfig`-with-four-hooks design does not survive contact
with the research. Two layers instead, following the repo's existing
"export the decode pipeline, let the sibling supply its own Config/URL/body"
precedent ([OpenAIDeepResearch.ts:17](../packages/providers/responses/src/OpenAIDeepResearch.ts#L17)):

**Layer 1: exported codec primitives** (`@effect-uai/openai-compatible/codec`),
each independently usable and testable:

```
itemsToMessages / appendToolCall / encodeContent
toolsWire / toolChoiceWire / responseFormatWire
WireChunk schemas / decodeChunk
Accumulator / applyChunk / accumulatorToTurn / stopReasonOf
httpStatusError / transportFailure
```

**Layer 2: a `make`/`layer` convenience** over those primitives for the ~80% of
providers that don't deviate:

```ts
export type ChatConfig = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl: string
  readonly provider: string                 // AiError tagging
  readonly path?: string                    // default "/chat/completions"
  readonly authHeader?: (key: Redacted.Redacted) => HttpClientRequest => HttpClientRequest
  readonly extraHeaders?: Record<string, string>          // OpenRouter HTTP-Referer/X-Title, Requesty X-Requesty-*
  readonly extraBody?: (request: CommonRequest) => Record<string, unknown>
  readonly decorateTurn?: (turn: Turn, raw: unknown) => Turn
}

export const make: (cfg: ChatConfig) => Effect<LanguageModelService, never, HttpClient>
export const layer: (tag, cfg: ChatConfig) => Layer<... | LanguageModel, never, HttpClient>
```

Providers that deviate (Mistral, Jina) compose Layer 1 directly rather than
forcing more hooks into `ChatConfig`. The hooks that were tempting but are
**rejected as config fields**, because they belong to exactly one provider each:
`imageUrlWire` (Mistral bare-string), `finishReasonMap` (Mistral `model_length`),
`normalizeToolCallId` (Mistral 9-char), `stripThinkTags` (Jina),
`annotationCodec` (Jina camelCase).

Per [feedback_dont_unify_non_uniform], a knob earns a place in `ChatConfig` only
if two or more providers genuinely share it. `extraHeaders` qualifies (both
routers). The rest do not.

## Per-provider deviation ledger

What each consumer needs beyond the generic base. This is the acceptance criteria
for the primitives being factored correctly.

| Provider             | Deviations                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mistral**          | `required`→`"any"` tool_choice; `safe_prompt`/`random_seed`; bare-string `image_url`; `model_length` finish reason; **rejects `max_completion_tokens` (422)**; strict 422 on unknown fields; **tool-call ids must match `^[a-zA-Z0-9]{9}$`**; `document_url` content part; hosted tools in `tools[]`                                                                                       |
| **OpenRouter**       | **Must skip `:`-prefixed SSE comment lines** (`: OPENROUTER PROCESSING`); **HTTP-200 mid-stream errors** (top-level `error` + `finish_reason: "error"`); `provider`/`models`/`route`/`plugins`/`reasoning` body fields; `HTTP-Referer`/`X-Title` headers; `reasoning_details[]` response array; `native_finish_reason`. Do **not** send `usage:{include:true}` or `transforms` (both dead) |
| **Requesty**         | Top-level `requesty` object (`tags`/`user_id`/`trace_id`/`auto_cache`/…); `policy/` model prefix for routing; EU base URL as a first-class config concern; `stream_options:{include_usage:true}` needed for streamed usage; `usage.cost`                                                                                                                                                   |
| **Jina DeepSearch**  | Separate host `deepsearch.jina.ai` (not `api.jina.ai`); **no tool calling at all**; reasoning inlined as `<think>…</think>` in `delta.content`; **camelCase** `url_citation` (`exactQuote`/`dateTime`, no indexes); `visitedURLs`/`readURLs` only on the final chunk, top-level                                                                                                            |
| **Perplexity sonar** | `search_results`→`Annotation`; sync chat endpoint; codec largely already written in `PerplexityDeepResearch.ts`                                                                                                                                                                                                                                                                            |

## Phases

### Phase 0: verification probes

Cheap live probes that de-risk everything downstream. Each is one scripted request
against a real key; record results back into [research/](./research/).

- OpenRouter: confirm the top-level `provider` response field exists (docs omit it);
  capture a real `: OPENROUTER PROCESSING` frame and a mid-stream error frame.
- Requesty: confirm `/v1/responses` really has no `previous_response_id` (this is an
  inference from absence, not a documented statement); confirm EU base URL behavior.
- Jina: confirm the DeepSearch field table against a live call (no OpenAPI spec
  exists); confirm whether `visitedURLs` appears on non-streaming responses.
- Mistral: confirm the 9-char tool-call-id rejection, including whether it applies
  to `tool_call_id` on replay as well as `tool_calls[].id`.

### Phase 1: fix the Mistral tool-call-id bug

Independent of the extraction, and shippable first. Normalize ids at the Mistral
boundary in both directions, and replace the `` `call_${index}` `` fallback with a
9-char alphanumeric generator. Add the regression test the current suite lacks.

### Phase 2: extract the base

Create `@effect-uai/openai-compatible` at **0.11.0** (per
[project_fixed_group_initial_version]), peer-depping `@effect-uai/core` and
`effect`, zero runtime deps, matching the provider package.json/tsdown conventions.
Lift the generic pieces out of `mistral/src/codec.ts` unchanged. Move
`mistral/src/codec.test.ts` alongside them as the regression guard, per
[feedback_meaningful_tests] routing through the real decode path.

Also close the gaps the audit found while the code is open: the SSE decoder must
skip `:` comment lines (needed by OpenRouter, harmless elsewhere), and the
`Effect.option` swallow of unmodelled payloads
([Mistral.ts:101-104](../packages/providers/mistral/src/Mistral.ts#L101-L104))
must not silently eat an OpenRouter error frame.

### Phase 3: reimplement Mistral on the base

`safePrompt`/`randomSeed` become `extraBody`; the five real deviations compose the
primitives directly. Parity proven by the existing tests. Fix the two audit nits
in passing: the double `make(cfg)` call in `layer`
([Mistral.ts:182-193](../packages/providers/mistral/src/Mistral.ts#L182-L193))
and the `Redacted.value` string interpolation for auth
([Mistral.ts:120](../packages/providers/mistral/src/Mistral.ts#L120)), which should
use `HttpClientRequest.bearerToken` like the rest of the repo.

### Phase 4: OpenRouter and Requesty

Two new packages, `@effect-uai/openrouter` and `@effect-uai/requesty`, each a thin
`ChatConfig` plus a provider-typed request. Both are the first real test of the
base being genuinely reusable.

Open question for both: **model ids are not a fixed union.** Every other provider
package narrows `model` to a literal union
([mistral/src/models.ts:12-23](../packages/providers/mistral/src/models.ts#L12-L23)),
but a router's catalogue is thousands of models and changes daily. Options: a
`string` model field (loses all type safety, breaks the house pattern), a
`string & {}` union trick for autocomplete-without-exhaustiveness, or a curated
union of popular ids plus an escape hatch. Decide before implementation; this is
the one design question the research doesn't answer.

Requesty's EU story is a config concern, not just a base URL: EU compliance
requires an EU endpoint **and** an EU model (region-suffixed ids like
`@eu-central-1`). Document both; do not imply the base URL alone is sufficient.

### Phase 5: Jina DeepSearch and Perplexity sonar

`@effect-uai/jina` gains a `JinaDeepSearch` module (one package per provider brand,
per [feedback_one_package_per_provider]), registering `LanguageModel`. It composes
the primitives rather than `ChatConfig`, because of the `<think>` stripping and the
camelCase annotation codec. **No tool calling**: passing `tools` must fail with
`AiError.InvalidRequest` rather than silently dropping them. Model id is
`jina-deepsearch-v1` only. While in the package, fix the drifted duplicate
`httpStatusError` copies and the false `rerank` claim in its published
description/keywords.

`@effect-uai/perplexity` gains the sync sonar `LanguageModel`, reusing the codec
already sitting in its DeepResearch module and mapping `search_results` to
`Items.Annotation` (the citation payoff on the LM path).

### Phase 6 (deferred): Responses dialect for the routers

Gated on OpenRouter's Responses leaving beta. Requires parameterizing
`@effect-uai/responses`, which today has four blockers, all small: auth fixed to
`bearerToken`, path shape fixed, `provider` tag hardcoded to `"responses"`/`"openai"`,
and `ResponsesTools.ts:137-141` rejecting hosted tools whose `provider !== "openai"`.
That parameterization is worth doing on its own merits (Azure's `api-key` auth needs
the same hook), so it can land ahead of any router work.

## Notes

- **Citations.** Chat Completions has no streamed-annotation events (unlike
  Responses). Providers that ground bundle sources in the final payload, so
  `decorateTurn` attaches them to the assembled `Turn`'s `OutputText.annotations`
  (surfaced via `Turn.citations`), not as streamed `CitationAdded`. Consistent with
  the citation model in `deep-research.md` Appendix A.
- **Package vs core module.** Settled: standalone package, so `core` stays
  wire-agnostic.
- **Relationship to Responses.** Still two different wire dialects. This base is
  Chat Completions only; do not fold in Responses. Phase 6 parameterizes the
  Responses package separately rather than merging the two.
- **Docs.** Each new LanguageModel provider needs a `docs/providers/<name>.md`
  following the fixed section order in
  [docs/providers/mistral.md](../docs/providers/mistral.md), written usage-POV per
  [feedback_provider_docs_usage_pov].
