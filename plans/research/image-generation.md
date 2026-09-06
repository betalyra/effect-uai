# Research: image generation (v0.13 item 3)

Provider survey and recipe selection for
[v0-13.md](../v0-13.md) item 3. Primary sources (API docs, pricing
pages, vendor cookbooks) plus the Arena and Artificial Analysis
leaderboards, 2026-09-04. Unconfirmed claims are marked UNVERIFIED.
Full subagent reports are in [image-generation/](./image-generation/).

## Verdict up front

Two things in the v0.13 plan are stale:

- `gpt-image-1` shuts down 2026-12-01. Target `gpt-image-2`.
- Imagen shut down on the Gemini API 2026-08-17. Google's image line
  is now Nano Banana (`gemini-3.1-flash-image` and siblings).

Launch providers stay **OpenAI** and **Google** as planned: both are
top-10 on quality, both have a fast tier, both packages already exist.
The next cheap wins are **xAI** and **Meta**, which are top-5 on
quality and use the OpenAI Images wire shape, so one codec covers
three vendors. **BFL** has fallen out of the top 15 and is
async-poll-only; keep it as a docs candidate. **fal.ai** is the
aggregator that hosts almost every top-10 model.

## Main providers and their models

| Provider     | Quality model (Arena T2I / edit rank)                                | Fast model                                                 | Price / image                         | API shape                                              | Edit | Mask        | Refs                            | Partials |
| ------------ | -------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ | ---- | ----------- | ------------------------------- | -------- |
| OpenAI       | `gpt-image-2` (#1 / #1)                                              | `gpt-image-2` quality `low`; `gpt-image-1-mini`            | ~$0.05 medium, $0.006 low             | sync Images API (b64) + Responses tool                 | yes  | yes         | yes                             | yes      |
| Google       | `gemini-3-pro-image` (#12 / #9), `gemini-3.1-flash-image` (#7 / #10) | `gemini-3.1-flash-lite-image` (sub-2s target, 1K only)     | Pro $0.134, Flash $0.067, Lite $0.034 | sync `generateContent` / Interactions API (inline b64) | yes  | prompt-only | yes (10 obj + 4 char + 3 style) | no       |
| xAI          | `grok-imagine-image-2.0` (#3 / #3)                                   | `grok-imagine-image` v1                                    | $0.04 (v2), $0.02 (v1)                | sync, OpenAI-compatible `/v1/images/*`                 | yes  | region      | up to 5                         | no       |
| Meta         | Muse Image 1.0 (#5 / #4)                                             | same                                                       | $0.01                                 | sync, OpenAI-compatible at `api.meta.ai/v1`            | yes  | UNVERIFIED  | yes                             | no       |
| ByteDance    | Seedream 5.0 Pro (#8 / #6)                                           | Seedream 5.0 Lite, Seedream 4.0 ("2K in 1.8s", UNVERIFIED) | Pro $0.0675 (fal), Lite $0.035        | sync ModelArk (OpenAI-like envelope); fal, Replicate   | yes  | UNVERIFIED  | up to 14                        | no       |
| Microsoft AI | `MAI-Image-2.6` (#2 / #2), released 2026-09-04                       | `MAI-Image-2.6-Flash`                                      | $38/M output tokens                   | Azure Foundry preview or OpenRouter only               | yes  | UNVERIFIED  | up to 5                         | no       |
| Alibaba      | `qwen-image-3.0-pro` (#9), closed weights                            | Qwen-Image Lightning (open, 4-step)                        | not confirmed; $0.02/MP on fal        | Model Studio sync + async; fal                         | yes  | UNVERIFIED  | UNVERIFIED                      | no       |
| BFL          | FLUX.2 [max] / [pro] (not in top 15)                                 | FLUX.2 [klein] 4B/9B (sub-second claim), FLUX.1 schnell    | pro $0.03, klein $0.014               | async submit + poll only (signed URL, 10 min)          | yes  | yes         | up to 10                        | no       |

Aggregators: **fal.ai** hosts gpt-image-2, Seedream 5, Nano Banana
2/Pro, Muse, Qwen 3, Ideogram 4, Kling O3, HunyuanImage 3 (sync
`fal.run` or queue + webhook). **OpenRouter** has a unified
`POST /api/v1/images` with SSE partials across gpt-image-2, MAI, Muse,
Grok, Seedream, FLUX.2. **Replicate** and **Together** are
second-tier coverage.

Not worth targeting: **Reve** (#4 quality, API sunset 2026-08-14),
**Midjourney** (no official API), **MiniMax** (Image-01 from Feb 2025,
nothing newer, cheapest at $0.0035), **Stability** (no 2026
flagship), **Luma** (Uni-1 API waitlisted), **Fireworks** (image
generation deprecated). **Ideogram 4.0** (text rendering, open
weights) and **Recraft V4.1** (native SVG) are niche specialists.
Anthropic has no image generation.

Sources: [Arena T2I](https://arena.ai/leaderboard/text-to-image),
[Arena edit](https://arena.ai/leaderboard/image-edit),
[Artificial Analysis](https://artificialanalysis.ai/image/leaderboard/text-to-image),
[OpenAI guide](https://developers.openai.com/api/docs/guides/image-generation),
[OpenAI deprecations](https://developers.openai.com/api/docs/deprecations),
[Gemini image docs](https://ai.google.dev/gemini-api/docs/image-generation),
[Gemini pricing](https://ai.google.dev/gemini-api/docs/pricing),
[Imagen shutdown](https://ai.google.dev/gemini-api/docs/imagen),
[xAI docs](https://docs.x.ai/docs/guides/image-generation),
[Meta Muse](https://developer.meta.com/ai/resources/blog/build-with-muse-Image/),
[Seedream on fal](https://fal.ai/models/bytedance/seedream/v5/pro/text-to-image),
[MAI-Image-2.6](https://microsoft.ai/news/pushing-the-quality-cost-frontier-with-mai-image-2-6/),
[BFL pricing](https://docs.bfl.ml/quick_start/pricing),
[BFL generating](https://docs.bfl.ml/quick_start/generating_images),
[fal queue](https://fal.ai/docs/model-endpoints/queue),
[OpenRouter images](https://openrouter.ai/docs/guides/overview/multimodal/image-generation),
[Reve API sunset](https://help.reve.com/hc/en-us/articles/46837930295316-Reve-API).

## Which providers to add

Recommendation: **one new package, `@effect-uai/fal`**, plus
extending the two existing packages. Everything else is reachable
without a new package.

| Provider         | How                                           | Why                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI           | extend `@effect-uai/openai`                   | #1 quality, mask, partials, Responses tool. Already planned.                                                                                                                                                               |
| Google           | extend `@effect-uai/google`                   | Top-10 quality plus the best fast model (Nano Banana 2 Lite). Already planned, target is Nano Banana not Imagen.                                                                                                           |
| fal.ai           | **new `@effect-uai/fal`**                     | One package reaches Seedream, Qwen, Muse, Ideogram, Kling, HunyuanImage, FLUX.2 klein and schnell: the whole Chinese and open-weights field plus the sub-second tier. Sync `fal.run` plus queue, one auth, one wire shape. |
| xAI, Meta        | OpenAI-Images-compatible base URL, no package | Both expose `/v1/images/generations` and `/v1/images/edits`. Same move as OpenRouter over `chat-completions`: make the OpenAI Images codec take a base URL and document them as gateways.                                  |
| Microsoft MAI    | docs only (OpenRouter)                        | #2 quality but Azure Foundry preview or OpenRouter only. Revisit when there is a standalone API.                                                                                                                           |
| BFL              | docs candidate                                | Out of the top 15, async-poll only, and klein is on fal anyway.                                                                                                                                                            |
| ByteDance direct | via fal                                       | ModelArk docs did not render and model ids are unverified; fal hosts Seedream 5 Pro and Lite.                                                                                                                              |

Defer: Recraft (SVG niche), Ideogram direct (on fal), Stability, Luma
(waitlist), MiniMax (stale), Reve (sunset), Midjourney (no API).

## Routers: is there a common image schema?

No formal standard. The OpenAI Images API is the de-facto baseline
(paths `/v1/images/generations` and `/v1/images/edits`, envelope
`{ created, data: [{ url | b64_json }], usage }`), but hosts copy it
far less faithfully than Chat Completions. OpenRouter built its own
schema instead.

| Host           | Path                               | Request shape                                                                       | Edits                                   | Mask            | Streaming            |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------- | --------------- | -------------------- |
| OpenAI         | `/v1/images/generations`, `/edits` | baseline                                                                            | multipart `image[]`                     | yes             | SSE partial images   |
| Requesty       | same paths                         | OpenAI subset (no stream, no usage in schema)                                       | multipart or JSON `images[{image_url}]` | yes             | no                   |
| Vercel Gateway | same paths                         | OpenAI plus `providerOptions`                                                       | multipart or JSON                       | model-dependent | no                   |
| Meta           | same paths                         | OpenAI, claimed verbatim                                                            | `image` / `images[]`                    | UNVERIFIED      | SSE completed events |
| xAI            | same paths                         | OpenAI subset plus `aspect_ratio`, `resolution`; no `size`                          | JSON `images[]`                         | no              | no                   |
| Azure          | deployment-scoped OpenAI paths     | OpenAI minus `response_format`                                                      | yes                                     | yes             | yes                  |
| OpenRouter     | `POST /api/v1/images` (own)        | custom: `input_references[]`, `resolution`, `aspect_ratio`, `seed`; `b64_json` only | same call via `input_references`        | no              | SSE, own event names |
| Together       | `/v1/images/generations` only      | custom: `width`, `height`, `steps`, `image_loras`                                   | same endpoint via `image_url`           | no              | no                   |

Requesty, OpenRouter, and Vercel all still route Gemini-style
multimodal models through chat completions with
`modalities: ["text","image"]` and `message.images[]`. OpenRouter
calls that path legacy and adds new image models only to the
dedicated endpoint.

**Verdict.** One OpenAI-Images codec parameterised by base URL covers
OpenAI, Requesty, Vercel Gateway, Meta, Azure, LiteLLM, and Portkey,
provided the codec keeps every request field optional, decodes
`data[]` items with optional `url`, `b64_json`, `revised_prompt`, and
media type, treats `created` and `usage` as optional, and supports
both multipart and JSON reference images for edits. xAI fits with two
extra fields. OpenRouter needs its own small codec (different path,
`input_references`, own SSE names, no edits path). Together and
Fireworks do not fit at all and are reachable through fal anyway.

Full report: [image-generation/router-schemas.md](./image-generation/router-schemas.md).

## Speed tier in one line each

- Truly sub-second: FLUX.2 klein and FLUX.1 schnell on fal / Together
  ($0.003 to $0.006 per MP), Luma Photon Flash ($0.002, UNVERIFIED
  latency).
- Sub-2s target with real quality: Nano Banana 2 Lite ($0.034, Elo
  1290, well above every other fast model).
- Cheap but not fast: OpenAI `low` tier ($0.006). Third-party
  measurements put it in the tens of seconds, UNVERIFIED.
- Measured latencies per model could not be extracted from Artificial
  Analysis (client-rendered charts); numbers above are vendor claims.

## API shapes

1. Sync REST, image inline as base64 or URL, usually in an
   OpenAI-style `{ data: [{ url | b64_json }] }` envelope: OpenAI,
   xAI, Meta, ByteDance ModelArk, Together, Recraft, Ideogram, MiniMax.
   Gemini is sync too but returns `inlineData` parts.
2. Async submit + poll: BFL (poll `polling_url` every ~0.5s, result is
   a signed URL valid 10 minutes, no webhooks), Luma, Kling.
3. Both: fal (`fal.run` sync, `queue.fal.run` with SSE status +
   webhook).
4. Partial-image streaming: OpenAI only (`partial_images` 0-3 on both
   Images API and Responses), plus OpenRouter SSE passthrough.

Implication: the core `ImageGenerator` is one-shot `Effect<Images>`,
as the v0.13 plan says. Adapters hide the poll loop for async
vendors. Partials stay an OpenAI-typed extra, not a core promise.

## Model categories that change the shape

Quality vs speed is a model choice. These categories change the
request, the response, or the transport, so they need a decision.

| Category                                  | Who                                                                                                               | What differs                                                                                                                                                                                                                 | Status 2026                                  | Decision                                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM-native image output                   | Gemini (image part of the turn), OpenAI / xAI / Meta (Responses `image_generation` tool)                          | Image is a chat output, not an endpoint. Continuation via `previous_response_id` / `previous_interaction_id` / `image_generation_call.id`. Gemini cannot mix with function calling. OpenAI's tool coexists with other tools. | Mainstream, all four ship it                 | **Matters most.** Not an `ImageGenerator` call. Needs an image content part in `TurnEvent` / assistant message, plus passthrough for the provider tool. This is what the `conversational-image-edit` recipe actually uses. |
| Diffusion sampler knobs                   | Open weights on fal / Replicate / Together / BFL flex and klein                                                   | `num_inference_steps`, `guidance_scale`, `negative_prompt`, `seed`, `acceleration`, safety toggle. No host exposes a sampler name. `seed` is on everything except gpt-image-2 and Gemini.                                    | Mainstream on open-weights hosts             | Provider-typed on the fal request. `seed` stays off the common request since the two frontier models lack it.                                                                                                              |
| Control inputs (ControlNet, canny, depth) | Stability only, still SD3.5-era; BFL Canny/Depth deprecated 2025-10-31                                            | Control image + type + strength.                                                                                                                                                                                             | Niche and receding                           | Skip. The 2026 shape is "prompt + N reference images" with no control type, which the common request already covers.                                                                                                       |
| LoRA at generate time                     | fal `loras: [{path, scale}]` (max 3), Replicate, Together, BFL `finetune_id`                                      | Reference to a weight file in the request. Training is separate.                                                                                                                                                             | Standard on every open-weights host          | Provider-typed field on fal. No training or CRUD, per package rules.                                                                                                                                                       |
| Image utilities, no prompt                | Upscale (Topaz, Stability, Recraft), background removal (BiRefNet), outpaint, erase, vectorize, Seedream layerize | Image in, image or mask or layers out. No prompt, no seed, no steps.                                                                                                                                                         | Common, but no AI SDK unifies them           | Separate capability if ever, not `ImageGenerator`. Out of scope for v0.13.                                                                                                                                                 |
| Non-raster output                         | Recraft SVG; transparent PNG (OpenAI `background`, Ideogram); Seedream layers                                     | Output is SVG text or multi-file.                                                                                                                                                                                            | Niche (Recraft is the only vector generator) | Response stays `Image` with a MIME type. `image/svg+xml` fits without a new type. Layers out of scope.                                                                                                                     |
| Real-time WebSocket diffusion             | fal `wss://fal.run/{model}/realtime`, msgpack, LCM / SDXL-Turbo only                                              | Long-lived socket, prompt-as-a-stream, binary frames.                                                                                                                                                                        | Niche, frozen at 2023-24 models              | Skip.                                                                                                                                                                                                                      |
| Batch APIs                                | OpenAI Batch (`/v1/images/*`), Gemini Batch; both 50% off, 24h                                                    | JSONL upload, poll, download.                                                                                                                                                                                                | Mainstream at OpenAI and Google              | Not image-specific. Belongs to a cross-capability batch story, not v0.13.                                                                                                                                                  |

## Capability design notes

Common request: prompt, reference images, size / aspect ratio, `n`,
a quality tier. Provider-typed: mask inpainting (OpenAI, BFL; Gemini
is prompt-only), transparent background (OpenAI), search grounding
(Gemini), partial streaming (OpenAI), `input_fidelity` (OpenAI),
sampler knobs and `loras` (fal).

Separate `generate` / `edit` methods, resolving the plan's open
question: every vendor exposes edit as a distinct endpoint or request
shape, and the required fields differ.

Two surfaces, not one. The standalone `ImageGenerator` service covers
`/v1/images`-style endpoints and fal. LLM-native image output is a
`LanguageModel` concern: an image part in the assistant turn and the
provider's built-in tool. Vercel AI SDK and LangChain both keep it
inside the chat call (`result.files`, `image_url` content blocks) with
no separate abstraction. Output reuses `Image` / `ImageSource` from
core on both surfaces, so generated images feed straight back into a
multimodal call, which the critique recipe depends on.

## Recipes

Every vendor ships image generation in two shapes: a standalone
endpoint, and a built-in tool inside an agent loop (OpenAI Responses
`image_generation` tool with `previous_response_id` and
`revised_prompt`; Gemini Interactions API with
`previous_interaction_id`; OpenAI Agents SDK `ImageGenerationTool`;
Vercel AI SDK `ToolLoopAgent`). The second shape is effect-uai's
territory.

### Pick these four

| Recipe                      | What it shows                                                                                                                                                                         | Evidence it is common                                                                                                                                                                                                                                                                                                                                                                                                                                              | Mirrors               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------- |
| `storyboard`                | LLM emits a Schema shot list; character portraits generated first, then scenes rendered with portraits as references. Structured output feeding multi-ref edit in a two-stage Stream. | Google cookbook [Book_illustration](https://github.com/google-gemini/cookbook/blob/main/examples/Book_illustration.ipynb) and [consistent-imagery codelab](https://codelabs.developers.google.com/gemini-consistent-imagery-notebook); OpenAI cookbook multi-panel comics; gpt-image-2 "up to 8 coherent images"                                                                                                                                                   | `structured-output`   |
| `conversational-image-edit` | Agent loop with an image tool: model picks `generate` vs `edit`, loop threads prior image ids, drift guard re-anchors to the original reference every N turns.                        | Headline feature of every 2025-26 launch ([OpenAI](https://developers.openai.com/api/docs/guides/image-generation), [Gemini](https://ai.google.dev/gemini-api/docs/image-generation), [BFL Kontext](https://bfl.ai/blog/flux-1-kontext) warns of drift after ~6 edits); shipped in Figma, Adobe, Canva.                                                                                                                                                            | `agentic-loop`        |
| `ad-variant-matrix`         | Typed brief, Schema list of N variants (hook, mood, locale, product scene), parallel generation with a fast model, quality model for the shortlist.                                   | Dominant growth-marketing workflow ([guide](https://adlibrary.com/posts/guide-to-ai-ad-creative-generation): 15-30 variants QA'd to 6-10); OpenAI [transparent assets](https://developers.openai.com/cookbook/examples/multimodal/transparent-image-assets-for-campaigns-and-presentations) and [high input fidelity](https://developers.openai.com/cookbook/examples/generate_images_with_high_input_fidelity) cookbooks; fal's customers Photoroom, Freepik.     | `multi-model-compare` |
| `critique-and-regenerate`   | Vision LLM judges the image against constraints (text spelled right, logo intact, brand rules) with a typed verdict; bounded retry or best-of-N.                                      | Standard production hardening ([creative QA](https://medium.com/madailab/building-an-ai-powered-creative-qa-system-combining-heim-metrics-with-llm-based-marketing-judgment-0c8b14be7c7b), [brand compliance](https://dzone.com/articles/automating-visual-brand-compliance-multimodal-llm), [VisionDirector](https://arxiv.org/html/2512.19243)); vendors internalise it as `revised_prompt` and Gemini thinking images. Only recipe with image input to the LLM. | `model-retry`         |

Optional: `product-scene-swap` as a small pure edit-with-fidelity
recipe if the matrix recipe gets too big; `partial-image-streaming`
as an OpenAI-only variant, matching `streaming-tool-output`.

### Reject

Standalone avatar/headshot (identity-sensitive, just an edit with a
face), standalone image localization (one edit call; fold into the
matrix as a locale dimension), style transfer alone, Gemini-only
search-grounded generation, infographic-from-data as its own recipe
(unverifiable output unless paired with the critic), LoRA fine-tuning
(resource management, out of scope).

## Decisions (2026-09-04)

The design doc is [plans/image-generation.md](../image-generation.md);
it wins on any conflict with this list.

- **Current models only.** No deprecated or sunsetting ids
  (`gpt-image-1*`, DALL-E, Imagen, `gemini-2.5-flash-image`, Gemini
  `-preview` ids). Nothing in the design accommodates them.
- **Launch providers:** OpenAI (`gpt-image-2`) and Google (Nano
  Banana 2 / Pro / Lite) by extending the existing packages. One new
  package, `@effect-uai/fal`, can trail into a patch release.
- **Gemini stays on `generateContent`.** Google calls it the
  recommended production path; Interactions is beta with a May 2026
  breaking change and no Batch. Wire details:
  [image-generation/gemini-wire.md](./image-generation/gemini-wire.md).
- **Two surfaces.** `ImageGenerator` service for endpoint-style
  generation and editing. LLM-native image output (Gemini image
  parts, OpenAI Responses `image_generation` tool) is a
  `LanguageModel` change, not an `ImageGenerator` variant.
- **Separate `generate` and `edit`.** Resolves the v0.13 open
  question.
- **Common request:** prompt, reference images, aspect ratio,
  resolution tier (`1K` / `2K` / `4K`), `n`. No `seed`, no quality
  tier (Gemini has none; its quality axis is the model).
- **Streaming partials** are a `streamGeneration` method on the
  generic service gated by an `ImageStreaming` marker, matching
  `SttStreaming` / `TtsIncrementalText`. Only OpenAI registers it.
- **No client-side per-model validation** (capabilities-plan §2.3).
  Send the request; translate the provider's 400 to `Unsupported`.
- **Provider-typed:** mask, exact `size`, quality, transparent
  background, moderation (OpenAI); `imageSize: "512"`, thinking level,
  search grounding (Gemini); sampler knobs (fal).
- **OpenAI Images codec takes a base URL**, same as
  `chat-completions`. xAI, Meta, Requesty, Vercel Gateway, Azure become
  gateway docs, not packages.
- **Postponed:** LoRA (one optional field on fal, later), OpenRouter
  image codec, image utilities (upscale, background removal,
  vectorize), real-time diffusion, control inputs, batch.
- **Recipes:** `storyboard`, `critique-and-regenerate`,
  `conversational-image-edit`, `ad-variant-matrix`.

## Repo audit: what core is missing

Checked 2026-09-04 against `packages/core/src/domain`:

- [Items.ts](../../packages/core/src/domain/Items.ts): `ContentBlock`
  is `InputText | InputImage | OutputText | Refusal`. There is no
  `OutputImage`. Needed for Gemini image parts and for threading
  generated images back into history.
- [Turn.ts](../../packages/core/src/domain/Turn.ts): `TurnEvent` has
  no image variant. Needed: an event carrying a completed image, and
  a `WebSearchCall`-style status event for the OpenAI built-in tool
  (started, generating, completed) so loops can render progress.
  Partial images can ride the same event with an index.
- [Image.ts](../../packages/core/src/domain/Image.ts): `ImageSource`
  (url, base64, bytes) is sufficient as the output type. No change.
- `providerData` passthrough already exists on every item, so the
  OpenAI `image_generation_call.id` continuation handle has a home
  without a new core field.

## Plan

| #   | Task                                                                                                                                                                                                                   | Lands in                | Size | Depends on |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---- | ---------- |
| 0   | Wire-level research and design doc. **Done 2026-09-04**: [openai-wire.md](./image-generation/openai-wire.md), [gemini-wire.md](./image-generation/gemini-wire.md), [plans/image-generation.md](../image-generation.md) | `research/`, `plans/`   | S    |            |
| 1   | Core: `Watermark` to `Media.ts`, `Image.ts` additions, `ImageGenerator` tag and `ImageStreaming` marker, `generate` / `edit` / `streamGeneration` helpers, docs skeleton                                               | core, docs              | S    | 0          |
| 2   | OpenAI Images adapter with base URL: generate, edit, mask, `streamGeneration`, registers `ImageStreaming`; mock tests                                                                                                  | openai                  | M    | 1          |
| 3   | Gemini adapter: Nano Banana 2 / Pro / Lite via `generateContent`, `streamGeneration` as `Unsupported`; mock tests                                                                                                      | google                  | M    | 1          |
| 4   | Recipes `storyboard` and `critique-and-regenerate`. **Done**: the critique loop landed inside `storyboard` (`rounds`, `rejected/`) rather than as a second recipe                                                      | recipes                 | S+S  | 2, 3       |
| 5   | Core: `OutputImage` content block, image `TurnEvent` variants, Gemini native image output, OpenAI Responses `image_generation` tool. **Gemini half done**; the Responses tool is deferred, see below                   | core, responses, google | L    | 0          |
| 6   | Recipe `conversational-image-edit`. **Done.** `ad-variant-matrix` **dropped**, see below                                                                                                                               | recipes                 | S    | 5; 2, 3    |
| 7   | Provider docs, gateway docs (xAI, Meta, Requesty, Vercel Gateway), migration doc, landing page. **Provider and turn docs done**; gateway docs and migration entry outstanding                                          | docs, webpage           | S    | 2, 3       |
| 8   | `@effect-uai/fal`. **Done**, though scoped to image endpoints: sync `fal.run`, `sync_mode` for inline bytes, reference-field discovery. No streaming, see below                                                        | new package             | M    | 1          |

Tasks 1 through 4 make a complete, shippable v0.13 item.

**Decisions taken during the build (2026-09-05):**

- **`ad-variant-matrix` dropped.** Generating N variants in parallel is
  `Effect.forEach` with a concurrency bound, which `multi-model-compare`
  and storyboard's cast stage already show. The use case is real; the
  recipe taught nothing the others do not. A reframing around
  role-tagged multi-reference composition ("your product photo, this
  setting, this style") was considered and also declined.
- **Task 5 split.** The Gemini half shipped: `OutputImage`,
  `TurnEvent.ImageOutput`, `assistantImages`, `imagesAsInput`,
  `Capabilities.warnDroppedBlocks`, decode and re-encode of `inlineData`
  parts, plus `responseModalities` / `imageConfig` on `GeminiRequest`.
  The Responses `image_generation` tool and its `ImageGenerationCall`
  event are deferred: reaching them needs OpenAI credits or a gateway
  that proxies hosted tools, and Requesty is known to strip features on
  the image path. Note that OpenAI's side is a hosted tool call, not
  native image output; `gpt-6-astra` is text-output only.
- **Providers other than Gemini drop `output_image` on replay** and warn,
  rather than inventing a wire form for it. `Turn.imagesAsInput` is the
  opt-in conversion.
- **fal has no image streaming.** Its `/stream` mechanism is for models
  authored on fal, the event shape is per-model, and no image endpoint
  documents partial images. The package registers `ImageGenerator` only.

Task 8 is additive and trails into a patch release.
