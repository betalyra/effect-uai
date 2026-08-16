# Protocols vs brands: packaging + docs plan (chat-completions, gateways, OpenAI, Mistral)

Goal: document `@effect-uai/chat-completions` (with a clear "prefer Responses"
warning), give OpenRouter and Requesty a home without full provider pages, and
make the protocol/brand separation clean, in the packages first and then in
the docs.

## Analysis

Two different kinds of thing currently share one mental slot:

- **Protocols** (open, multi-vendor): Responses (openresponses.org, an open
  standard beyond OpenAI) and Chat Completions (de-facto standard, "OpenAI-
  compatible"). These deserve protocol-named packages and protocol-named docs
  pages. `@effect-uai/responses` keeps its name: it is NOT the OpenAI package.
- **Brands** (proprietary surfaces): OpenAI speech and OpenAI embeddings are
  OpenAI APIs. Gateways clone them, but neither is an open standard. Brand
  surfaces live under the brand.

Current inconsistencies measured against that rule:

1. `@effect-uai/chat-completions` is undocumented (no page, no sidebar entry,
   no index row, no installation mention).
2. The embeddings page is titled "Responses / OpenAI (embeddings)". Wrong on
   both counts: `/v1/embeddings` is not part of the Responses standard, it is
   an OpenAI API that happens to live in the `responses` npm package.
3. The OpenAI brand is split across two packages (`openai` = speech,
   `responses` = LLM + embeddings) with no single "install OpenAI" story,
   violating one-package-per-brand (the rule Mistral already follows).
4. Mistral's LanguageModel is chat-completions with three codec quirks
   (bare-string `image_url`, forced tool choice `any` instead of `required`,
   extra `model_length` stop reason) and two typed extras (`safePrompt`,
   `randomSeed`). The codec is a 341-line near-duplicate of the extracted
   generic one; the tool-call-id fallback bug had to be fixed in both copies.
5. OpenRouter and Requesty are invisible in docs, and they cross-cut
   capabilities (both expose OpenAI-shaped `/audio/*`; Requesty also
   `/v1/embeddings`; our OpenAI speech/embedding layers all take `baseUrl`).

## Part 1: packages

### 1a. `@effect-uai/openai` re-exports the OpenAI surfaces of `responses`

Mirror of the Mistral discussion: the brand package aggregates, the protocol
package stays standalone.

- Add `@effect-uai/responses` as a dependency of `@effect-uai/openai` (same
  fixed-group version, workspace protocol).
- Re-export subpaths, names unchanged: `@effect-uai/openai/Responses`,
  `@effect-uai/openai/OpenAIEmbedding`, `@effect-uai/openai/OpenAIDeepResearch`,
  `@effect-uai/openai/ResponsesTools`.
- Result: `pnpm add @effect-uai/openai` covers LLM + embeddings + deep research
  + speech. Gateway users who only want the protocol adapter still install
  `@effect-uai/responses` alone (no audio surface pulled in conceptually; deps
  are peer-based anyway).
- No code moves, no breaking change. Physically relocating OpenAIEmbedding into
  `openai` is a possible later cleanup, out of scope here.

### 1b. Mistral LanguageModel on top of `@effect-uai/chat-completions`

Recommendation: do it. The duplication already produced a double-fix, and the
public Mistral API does not change at all.

- Extend `ChatConfig` with a small wire-variance bag (these are exactly the
  spots where real-world "compatible" endpoints diverge, so the generic
  adapter gets more honest, not more bloated):
  ```ts
  readonly wire?: {
    readonly imageUrl?: "object" | "string"        // default "object"
    readonly forcedToolChoice?: "required" | "any" // default "required"
    readonly stopReasonOverrides?: Record<string, StopReason>
  }
  ```
  Thread through `itemsToMessages` / `toolChoiceWire` / `reasonToStop` as
  optional parameters with current behavior as default.
- Rebuild `Mistral.make` as a wrapper over chat-completions `make` with
  `{ baseUrl, provider: "mistral", wire: { imageUrl: "string",
  forcedToolChoice: "any", stopReasonOverrides: { model_length: "max_tokens" } },
  extraBody }` where `extraBody` maps `safePrompt` / `randomSeed` from the
  (runtime-present) typed request. Typed tag, `MistralRequest`, `MistralModel`
  union, and the dual-tag layer stay identical.
- Delete the LLM half of `packages/providers/mistral/src/codec.ts`
  (audioCodec stays). Migrate `codec.test.ts` cases to chat-completions
  (parameterized over the wire bag) and keep `onHalt.test.ts` green against
  the wrapper.
- Gate: `pnpm --filter @effect-uai/mistral test` + one live smoke run of the
  basic-usage recipe against Mistral before merging.

## Part 2: docs

Naming rule: pages are named for the API surface they document. Protocol pages
say so explicitly and list known endpoints; the brand hub is the providers
index.

### 2a. Fix the OpenAI/Responses labels (no slug churn for the LLM page)

- `/providers/responses/`: keep slug, retitle to "Responses" and reframe the
  intro: the Open Responses protocol (link openresponses.org), OpenAI is the
  flagship implementation, `baseUrl` points the same layer at any conforming
  endpoint (gateways link). Install line can show `@effect-uai/openai` for the
  full OpenAI stack and `@effect-uai/responses` for protocol-only use.
  Sidebar label: "Responses (OpenAI, gateways)".
- `/embeddings/providers/responses/` -> `/embeddings/providers/openai/`,
  title "OpenAI (embeddings)", redirect from the old slug, import shown as
  `@effect-uai/openai/OpenAIEmbedding` (the 1a re-export). Sidebar label
  "OpenAI". This kills the false "Responses" label where it is actually wrong.
- Speech pages unchanged: OpenAI speech is a brand surface and stays "OpenAI".
- `docs/providers/index.md` OpenAI section becomes the brand hub:
  `@effect-uai/openai` as the one-install package (re-exporting the Responses
  adapter), links: Language model -> Responses page, Embeddings -> OpenAI,
  Speech -> OpenAI.
- Mistral docs: no visible change from 1b; add one line that its LLM speaks
  the chat-completions dialect.

### 2b. New page: OpenAI-compatible (Chat Completions)

`docs/providers/openai-compatible.md`, last entry in Language models >
Providers.

- `:::caution` banner up top: Responses is the primary protocol in effect-uai;
  use Chat Completions only when the endpoint does not support Responses (or
  its support is immature). Name the losses concretely (from
  `plans/research/responses-vs-chat-completions.md`): no typed reasoning
  items, no server-side state (`store` / `previousResponseId`), delta-patch
  streaming instead of typed items.
- Install, `make` / `layer`, full `ChatConfig` reference including the `wire`
  bag from 1b (`path`, `authHeader`, `extraHeaders`, `extraBody`, `wire`).
- Supported: streaming, tools, structured output via `response_format`, usage.
  `model` is a plain string by design (gateways ship hundreds of models).
- Tool-call-id fallback note: when an endpoint omits ids we mint a 9-char
  alphanumeric id valid on every known validator.
- Errors table, see-also: Responses page, gateways page, Mistral (a typed
  consumer of this dialect).

### 2c. New page: Gateways (OpenRouter and Requesty)

`docs/providers/gateways.md`, top-level sidebar entry directly after
"Providers" (cross-cuts capabilities, so not inside the LLM subgroup).

- Framing: gateways are not providers; one key, hundreds of models, routing
  and billing on top. You use them through the protocol adapters; this page is
  a wiring table, not a new API.
- Per-gateway table: base URL, model id convention, dialect support
  (OpenRouter: chat stable, Responses beta and stateless; Requesty: chat
  stable, native Responses via the `openai-responses/` model prefix), notable
  headers (OpenRouter `HTTP-Referer` / `X-Title` via `extraHeaders`).
- Two short snippets only (chat-completions layer and responses layer pointed
  at a gateway); link the protocol pages for everything else.
- Audio section (short): both expose OpenAI-shaped `/audio/*`;
  `OpenAITranscriber` / `OpenAISynthesizer` accept `baseUrl`. Caveats from
  `plans/research/gateway-audio.md`: OpenRouter TTS formats mp3/pcm with pcm
  default, `verbose_json` gated by upstream; Requesty is OpenAI-models-only
  passthrough with a minimal transcription surface. Frame as "the gateway
  clones OpenAI's brand API", which is exactly why these stay in the openai
  package rather than a protocol package.
- Embeddings note: Requesty exposes `/v1/embeddings` (point `OpenAIEmbedding`
  at it); OpenRouter has none.
- Verification gate: run the speech and embedding recipes once against both
  gateways before publishing claims; anything unverified is phrased as
  "documented by the gateway" or dropped.

### 2d. Index, matrix, entry-point sweep

- `docs/providers/index.md`: add a "Gateways" table after Runtimes (OpenRouter,
  Requesty rows linking the gateways page) plus a sentence on why they are not
  in the capability matrix. Add a "Protocol adapters" note mentioning
  `@effect-uai/chat-completions` and `@effect-uai/responses`.
- `docs/start/installation.md`: recommend `@effect-uai/openai` for the OpenAI
  stack; list `@effect-uai/chat-completions` with the one-line warning framing.
- `recipes/basic-usage/README.md`: mention the `--dialect` flag next to the
  existing gateway example (recipe READMEs are the published recipe pages).
- Sidebar edits in `webpage/astro.config.mjs` collected from 2a to 2c, plus
  the embeddings redirect.

## Phase order

1a (openai re-export) -> 2a-2d (docs, so install snippets can already show
`@effect-uai/openai`). 1b (Mistral refactor) is independent and can land
before or after the docs work; only the `wire` bag reference in 2b depends on
it, so if 1b is deferred, document `ChatConfig` without `wire` and extend the
page later.

## Verify

- `pnpm typecheck`, `pnpm --filter @effect-uai/mistral test`,
  `pnpm --filter webpage build`; click through the embeddings redirect.
- Grep for remaining `/embeddings/providers/responses` links outside
  migrations (migrations stay historical, the redirect covers them).
- Live smoke: basic-usage against Mistral (post 1b), OpenRouter and Requesty
  in both dialects.
