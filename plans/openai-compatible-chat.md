# Plan: OpenAI-compatible Chat Completions `LanguageModel` base

Revised 2026-07-15 against six research reports in [research/](./research/):
[openrouter.md](./research/openrouter.md), [requesty.md](./research/requesty.md),
[jina-mistral.md](./research/jina-mistral.md),
[gateway-audio.md](./research/gateway-audio.md),
[responses-vs-chat-completions.md](./research/responses-vs-chat-completions.md),
[repo-audit.md](./research/repo-audit.md).

## What this is

A shared, reusable `LanguageModel` implementation for the **OpenAI Chat
Completions** wire dialect (`POST /chat/completions`, `messages[]` in,
`choices[].message` / `choices[].delta` out, `data: [DONE]` SSE terminator).
This is the _old_ OpenAI API, distinct from the Responses API (`/v1/responses`,
the `@effect-uai/responses` package).

Consumers: **Mistral** (today's sole implementation), **Jina DeepSearch**,
**Perplexity sync sonar**, **OpenRouter**, and the long tail of gateways we will
never package (Groq, Together, Fireworks, vLLM, self-hosted proxies).

## Framing: this is a compatibility play with a shelf life

Worth stating plainly, because it sets how much to invest. Chat Completions is
**neither legacy nor safely permanent**. It is a stable lingua franca being
hollowed out from the top:

- OpenAI pledged to support it *"indefinitely"*, and it remains the universal
  provider dialect and the default in LangChain and LiteLLM.
- But **GPT-5.4 Pro and GPT-5.5 Pro shipped Responses-only**, OpenAI removed Chat
  Completions from its own Codex client, and every hosted tool since March 2025 is
  Responses-only. Assistants dies 2026-08-26.
- The ecosystem is converging on the Responses **item model** while rejecting its
  **server-side state**: OpenRouter's Responses is stateless by design, and vLLM's
  RFC proposes stripping state to make it horizontally scalable.

So build this because Mistral, Jina, and Perplexity have **no Responses option and
likely never will**, and because it is the mature surface on OpenRouter. Do not
build it as the long-term strategic substrate. Details in
[responses-vs-chat-completions.md](./research/responses-vs-chat-completions.md).

## Headline findings that changed this plan

1. **Both routers support the Responses API, but neither is a reason to route
   there.** OpenRouter's is **beta with breaking changes expected**, and `provider`
   routing (its entire value proposition) is undocumented on it. Requesty's is
   documented and non-beta, but its standard `openai/` prefix **routes through Chat
   Completions under the hood** anyway; only the `openai-responses/` prefix is
   native passthrough.
2. **Statelessness is a non-issue for us.** Neither router has
   `previous_response_id`. Our `CommonRequest` carries full `history` and every
   provider resends it, so we never depended on server-side state.
3. **"OpenAI-compatible" is thinner than the original plan assumed.** Mistral
   rejects `max_completion_tokens` with 422 and validates strictly; Jina emits
   camelCase citations, inlines reasoning in `<think>` tags, and supports no tool
   calling at all; OpenRouter injects `: OPENROUTER PROCESSING` SSE comments and
   reports mid-stream errors under HTTP 200. A single `ChatConfig` with four hooks
   will not absorb this.
4. **Mistral's 9-character tool-call-id constraint is a latent bug in our codec
   today.** `^[a-zA-Z0-9]{9}$` is enforced, and our fallback id is
   `` `call_${index}` ``
   ([mistral/src/codec.ts:261](../packages/providers/mistral/src/codec.ts#L261)),
   which has an underscore and the wrong length. It also breaks the
   multi-model-fallback recipe: Anthropic `toolu_…` and OpenAI `call_…` ids are
   rejected outright when replayed into Mistral.
5. **OpenRouter shipped dedicated audio APIs on 2026-05-01**, after this plan was
   first written. It now has TTS, STT, chat-embedded audio input, and chat audio
   output. This is what makes an `@effect-uai/openrouter` package worth minting.
6. **Perplexity already carries most of a chat-completions codec** in
   [PerplexityDeepResearch.ts](../packages/providers/perplexity/src/PerplexityDeepResearch.ts),
   and its `models.ts` already types `sonar`/`sonar-pro` for "the sync chat
   endpoint" that doesn't exist yet.

## Packaging: which brands get a package

The deciding principle, settled during review: **a package is the front door for a
brand that has more than one capability, and the base disappears behind it.** Not
"how much code does the wrapper contain."

| | Decision |
|---|---|
| `@effect-uai/chat-completions` | **User-facing package.** The honest answer for gateways generally: a gateway is defined by its URL, not its brand. Serves the long tail directly. Named for the dialect, not for "OpenAI-compatible", which would read as an endorsement exactly as the ecosystem moves to Responses. |
| `@effect-uai/mistral` | Keeps its front door. Composes primitives (five real deviations). Also has Transcriber, SttStreaming, SpeechSynthesizer. |
| `@effect-uai/jina` | Gains `JinaDeepSearch` alongside Embedding + Reader. Composes primitives. |
| `@effect-uai/perplexity` | Gains sync sonar `LanguageModel` alongside WebSearch + DeepResearch. |
| `@effect-uai/openrouter` | **New package.** LanguageModel + Synthesizer + Transcriber. Earns it on capability breadth; its audio is its own interface, not an OpenAI clone. |
| Requesty | **No package. Docs page over `chat-completions`.** See below. |

### Why Requesty is deferred

Two reasons, and the second is stronger:

1. With no model union (see below) and its audio excluded, a Requesty package would
   contain a prefilled `baseUrl`, a small `requesty` metadata bag, and a `policy/`
   model-name convention. Per [feedback_no_per_provider_shortcuts], that does not
   justify the API surface.
2. **A package could not enforce the thing you would want it for.** EU compliance
   requires an EU endpoint **and** an EU-region model suffix
   (`@eu-central-1`, `@europe-west1`, …). Without a model union we cannot validate
   the model half. A package that looks like it guarantees GDPR compliance but only
   sets a base URL is worse than a docs page explaining both halves.

Requesty's audio is **OpenAI-passthrough only** (*"Currently only OpenAI models are
supported"*), so shipping Synthesizer/Transcriber there would ship a capability
that structurally cannot meet the compliance goal. Revisit when Requesty routes
audio to non-OpenAI models; that would restore the breadth argument honestly.

The docs page must show `https://router.eu.requesty.ai/v1` **and** the region-suffix
model requirement.

### Model ids: no union for gateways

Decided: **no literal union for OpenRouter or the generic package.** Every other
provider narrows `model` to a union
([mistral/src/models.ts:12-23](../packages/providers/mistral/src/models.ts#L12-L23)),
but a router's catalogue is thousands of models changing daily. This is the one
structural way gateway packages differ from the house pattern. Consider
`string & {}` for autocomplete without exhaustiveness.

## Shape

The original single-`ChatConfig`-with-four-hooks design does not survive contact
with the research. Two layers instead, following the repo's existing "export the
decode pipeline, let the sibling supply its own Config/URL/body" precedent
([OpenAIDeepResearch.ts:17](../packages/providers/responses/src/OpenAIDeepResearch.ts#L17)):

**Layer 1: exported codec primitives**, each independently usable and testable:

```
itemsToMessages / appendToolCall / encodeContent
toolsWire / toolChoiceWire / responseFormatWire
WireChunk schemas / decodeChunk
Accumulator / applyChunk / accumulatorToTurn / stopReasonOf
httpStatusError / transportFailure
```

**Layer 2: a `make`/`layer` convenience** over those primitives, for providers that
don't deviate:

```ts
export type ChatConfig = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl: string
  readonly provider: string                 // AiError tagging
  readonly path?: string                    // default "/chat/completions"
  readonly authHeader?: (key: Redacted.Redacted) => HttpClientRequest => HttpClientRequest
  readonly extraHeaders?: Record<string, string>
  readonly extraBody?: (request: CommonRequest) => Record<string, unknown>
  readonly decorateTurn?: (turn: Turn, raw: unknown) => Turn
}

export const make: (cfg: ChatConfig) => Effect<LanguageModelService, never, HttpClient>
export const layer: (tag, cfg: ChatConfig) => Layer<... | LanguageModel, never, HttpClient>
```

Providers that deviate (Mistral, Jina) compose Layer 1 directly rather than forcing
more hooks into `ChatConfig`. Rejected as config fields, because each belongs to
exactly one provider: `imageUrlWire` (Mistral bare-string), `finishReasonMap`
(Mistral `model_length`), `normalizeToolCallId` (Mistral 9-char), `stripThinkTags`
(Jina), `annotationCodec` (Jina camelCase).

Per [feedback_dont_unify_non_uniform], a knob earns a place in `ChatConfig` only if
two or more providers genuinely share it.

## Per-provider deviation ledger

Acceptance criteria for the primitives being factored correctly.

| Provider | Deviations |
|---|---|
| **Mistral** | `required`→`"any"` tool_choice; `safe_prompt`/`random_seed`; bare-string `image_url`; `model_length` finish reason; **rejects `max_completion_tokens` (422)**; strict 422 on unknown fields; **tool-call ids must match `^[a-zA-Z0-9]{9}$`**; `document_url` content part; hosted tools in `tools[]` |
| **OpenRouter** | **Must skip `:`-prefixed SSE comment lines**; **HTTP-200 mid-stream errors** (top-level `error` + `finish_reason: "error"`); `provider`/`models`/`route`/`plugins`/`reasoning` body fields; `HTTP-Referer`/`X-Title` headers; `reasoning_details[]`; `native_finish_reason`. Do **not** send `usage:{include:true}` or `transforms` (both dead) |
| **Jina DeepSearch** | Separate host `deepsearch.jina.ai`; **no tool calling at all**; reasoning inlined as `<think>…</think>` in `delta.content`; **camelCase** `url_citation` (`exactQuote`/`dateTime`, no indexes); `visitedURLs`/`readURLs` only on the final chunk, top-level |
| **Perplexity sonar** | `search_results`→`Annotation`; sync chat endpoint; codec largely already written in `PerplexityDeepResearch.ts` |
| **Requesty** (docs only) | Top-level `requesty` object; `policy/` model prefix; EU base URL + EU model suffix; `stream_options:{include_usage:true}` for streamed usage; `usage.cost` |

## Phases

### Phase 0: verification probes

Cheap live probes that de-risk everything downstream. One scripted request each
against a real key; record results back into [research/](./research/).

- **Mistral**: confirm the 9-char tool-call-id rejection, including whether it
  applies to `tool_call_id` on replay as well as `tool_calls[].id`. Gates Phase 1.
- **OpenRouter**: confirm the top-level `provider` response field exists (docs omit
  it); capture a real `: OPENROUTER PROCESSING` frame and a mid-stream error frame.
- **Jina**: confirm the DeepSearch field table against a live call (no OpenAPI spec
  exists); confirm whether `visitedURLs` appears on non-streaming responses.

### Phase 1: fix the Mistral tool-call-id bug

Independent of the extraction, shippable first. Normalize ids at the Mistral
boundary in both directions, and replace the `` `call_${index}` `` fallback with a
9-char alphanumeric generator. Add the regression test the current suite lacks
(`buildRequestBody` is entirely untested today).

### Phase 2: extract the base

Create `@effect-uai/chat-completions` at **0.11.0** (per
[project_fixed_group_initial_version]), peer-depping `@effect-uai/core` and
`effect`, zero runtime deps, matching the provider package.json/tsdown conventions.
Lift the generic pieces out of `mistral/src/codec.ts` unchanged. Move
`mistral/src/codec.test.ts` alongside them as the regression guard, per
[feedback_meaningful_tests] routing through the real decode path.

Close the two decoder gaps while the code is open, both needed by OpenRouter and
harmless elsewhere:

- Skip `:`-prefixed SSE comment lines before `JSON.parse`.
- The `Effect.option` swallow of unmodelled payloads
  ([Mistral.ts:101-104](../packages/providers/mistral/src/Mistral.ts#L101-L104))
  must not silently eat an HTTP-200 error frame.

### Phase 3: reimplement Mistral on the base

`safePrompt`/`randomSeed` become `extraBody`; the deviations compose primitives
directly. Parity proven by the existing tests. Fix two audit nits in passing: the
double `make(cfg)` call in `layer`
([Mistral.ts:182-193](../packages/providers/mistral/src/Mistral.ts#L182-L193)) and
the `Redacted.value` string interpolation for auth
([Mistral.ts:120](../packages/providers/mistral/src/Mistral.ts#L120)), which should
use `HttpClientRequest.bearerToken` like the rest of the repo.

### Phase 4: OpenRouter

New package, the first real test of the base being reusable.

- **LanguageModel** on `ChatConfig`, with the `provider` routing block typed as a
  schema rather than a raw `extraBody` record. `zdr` and `data_collection` are
  compliance-relevant enough that a silent typo matters.
- **Synthesizer**: `POST /api/v1/audio/speech`. Note formats are only `mp3`|`pcm`
  and the default is `pcm`, not OpenAI's `mp3`.
- **Transcriber**: `POST /api/v1/audio/transcriptions`. Two request paths (OpenAI
  multipart, plus OpenRouter's own base64 JSON). `prompt` is accepted-and-ignored
  upstream, and `verbose_json` works only on some providers: do not promise either.

Per [feedback_dont_unify_non_uniform], keep `voice` provider-typed. Across LiteLLM,
OpenRouter, and Requesty, only `{model, input, voice} → bytes` and
`{file, model} → {text}` normalize; timestamps, diarization, and voice identity do
not. Details in [gateway-audio.md](./research/gateway-audio.md).

### Phase 5: Jina DeepSearch and Perplexity sonar

`@effect-uai/jina` gains a `JinaDeepSearch` module registering `LanguageModel`.
Composes primitives rather than `ChatConfig`, because of `<think>` stripping and the
camelCase annotation codec. **No tool calling**: passing `tools` must fail with
`AiError.InvalidRequest` rather than silently dropping them. Model id is
`jina-deepsearch-v1` only (`v2` does not exist). While in the package: fix the
drifted duplicate `httpStatusError` copies and the false `rerank` claim in its
published description/keywords.

`@effect-uai/perplexity` gains the sync sonar `LanguageModel`, reusing the codec in
its DeepResearch module and mapping `search_results` to `Items.Annotation`.

### Phase 6: parameterize `@effect-uai/responses`

**Promoted out of "deferred"; no longer gated on router adoption.** The package
implements the Open Responses spec, which is now community-governed rather than an
OpenAI endpoint. Hardcoding one vendor into a multi-vendor spec implementation is a
design bug, not a reasonable simplification. Four blockers, all small:

1. Auth fixed to `HttpClientRequest.bearerToken` (no `authHeader` hook).
2. Path shape fixed (`${host}/responses`).
3. `provider` tag on `AiError` hardcoded to `"responses"`/`"openai"`.
4. [ResponsesTools.ts:137-141](../packages/providers/responses/src/ResponsesTools.ts#L137-L141)
   rejects hosted tools whose `tool.provider !== "openai"`.

Building router-Responses layers on top stays deferred: OpenRouter's is beta, and
Requesty's `openai/` prefix shims back to Chat Completions anyway.

## Notes

- **Citations.** Chat Completions has no streamed-annotation events (unlike
  Responses). Providers that ground bundle sources in the final payload, so
  `decorateTurn` attaches them to the assembled `Turn`'s `OutputText.annotations`
  (surfaced via `Turn.citations`), not as streamed `CitationAdded`. Consistent with
  the citation model in `deep-research.md` Appendix A.
- **Package vs core module.** Settled: standalone package, so `core` stays
  wire-agnostic.
- **Relationship to Responses.** Two different wire dialects. This base is Chat
  Completions only; do not fold in Responses. Phase 6 parameterizes the Responses
  package separately rather than merging the two.
- **No audio base.** With Requesty out, the shared audio surface is OpenRouter plus
  our existing `@effect-uai/openai`, and the genuinely-shared part is thin. Not
  worth a base today; revisit if a third OpenAI-shaped audio consumer appears.
- **Naming.** Settled: `@effect-uai/chat-completions`. Names the wire dialect
  rather than implying blessing, which `openai-compatible` would as the ecosystem
  moves to Responses.
- **Docs.** Each new LanguageModel provider needs a `docs/providers/<name>.md`
  following the fixed section order in
  [docs/providers/mistral.md](../docs/providers/mistral.md), written usage-POV per
  [feedback_provider_docs_usage_pov]. Requesty gets a page under the generic
  package rather than its own.
