# Plan: image generation (v0.13 item 3)

Design and implementation plan for the `ImageGenerator` capability and
for image output inside `LanguageModel` turns. Research behind every
claim: [research/image-generation.md](./research/image-generation.md)
(summary) and [research/image-generation/](./research/image-generation/)
(raw reports, including the wire schemas in
[openai-wire.md](./research/image-generation/openai-wire.md) and
[gemini-wire.md](./research/image-generation/gemini-wire.md)).

## Scope

Two surfaces, one release:

1. **`ImageGenerator` service** in core with `generate`, `edit`, and a
   marker-gated `streamGeneration`. Providers: OpenAI `gpt-image-2`
   via the Images API, Google Nano Banana 2 / Pro / Lite via
   `generateContent`.
2. **Image output in `LanguageModel` turns**: an `OutputImage` content
   block, image `TurnEvent`s, Gemini native image parts, and the
   OpenAI Responses `image_generation` built-in tool.

Current models only. No `gpt-image-1*`, no DALL-E, no Imagen, no
`gemini-2.5-flash-image`, no `-preview` Gemini ids (shut down
2026-06-25). Model unions carry the `(string & {})` tail as usual, so
a future id works without an SDK update.

Out of scope, decided: LoRA, OpenRouter image codec, image utilities
(upscale, background removal, vectorize), real-time diffusion,
ControlNet-style inputs, batch APIs, `@effect-uai/fal` (trails into a
patch release; plan separately).

## Consistency with the existing capabilities

The design below follows the shape shared by `Transcriber`,
`SpeechSynthesizer`, `MusicGenerator`, `EmbeddingModel`, and
`Reranker`. Checked against the code on 2026-09-04:

| Convention                                                                                                                                                                                                                                                 | Where it lives today                                                               | Applied here                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| One generic `Context.Service` tag at `@betalyra/effect-uai/<Name>`, `Common*Request` types with `model: string`, module-level helpers that `Effect.flatMap` the tag                                                                                        | every capability                                                                   | `ImageGenerator`, `CommonImageGenerateRequest`, `generate` / `edit`                                                                   |
| Provider request = `Omit<Common, "model"> & { model: TypedUnion; ...vendor knobs }`; provider tag at `@betalyra/effect-uai/providers/<pkg>/<Name>`; one `layer` registers both tags via `Layer.merge`, generic side casts the common request               | `GeminiSynthesizer`, `JinaReranker`, `Gemini`                                      | `OpenAIImageGenerator`, `GeminiImageGenerator`                                                                                        |
| Optional _methods_ on the generic service are gated by a `void` marker tag at `@betalyra/effect-uai/capability/<Name>`; the helper requires the marker; providers without the feature implement the method as `Unsupported` and do not register the marker | `SttStreaming`, `TtsIncrementalText`, `MultiSpeakerTts`, `MusicInteractiveSession` | `streamGeneration` gated by `ImageStreaming`; only OpenAI registers it. The earlier draft had this as an OpenAI-typed extra; changed. |
| Optional _modifiers_ do not get markers. Bucket 1 (structurally unhonourable) fails `Unsupported`; bucket 2 emits `warnDropped`; bucket 3 is silent                                                                                                        | capabilities-plan §4.4                                                             | mask and `n > 1` on Gemini are bucket 1; no new modifier markers                                                                      |
| No per-model capability tables in adapters. Send the request, translate the provider's error into `Unsupported`                                                                                                                                            | capabilities-plan §2.3 (`OpenAITranscriber`, `LyriaGenerator` removals)            | Lite-is-1K-only, Pro-has-no-512, OpenAI ratio limits: not checked client-side. The earlier draft pre-checked these; removed.          |
| `Config = { apiKey: Redacted; baseUrl?: string }`, OpenAI adds `region` and resolves via `resolveHost`                                                                                                                                                     | every provider; `region.ts`                                                        | same                                                                                                                                  |
| Result carries `watermark?: Watermark` when the provider applies one                                                                                                                                                                                       | `MusicResult` (`"synthid" \| "c2pa"`)                                              | `GeneratedImage.watermark`, Gemini sets `"synthid"`. `Watermark` moves to `domain/Media.ts`, re-exported from `Music` unchanged.      |
| Usage type is local, camelCase, every field optional                                                                                                                                                                                                       | `RerankUsage`, embedding `Usage`                                                   | `ImageUsage`                                                                                                                          |
| Provider-typed LLM knobs live on the provider request (`GeminiRequest.thinkingBudget`), the generic layer casts                                                                                                                                            | `Gemini.ts`                                                                        | `GeminiRequest.responseModalities`, `.imageConfig`; image model ids join `GoogleModel`                                                |
| Provider-hosted LLM tools are `Tool.provider` with a `kind` discriminated config                                                                                                                                                                           | `ResponsesTools.ts`                                                                | `imageGenerationTool`, `kind: "image_generation"`                                                                                     |
| Docs: `docs/<capability>/index.md` usage-POV plus `docs/<capability>/providers/<provider>.md`                                                                                                                                                              | `docs/music-generation/`, `docs/embeddings/`                                       | `docs/image-generation/index.md`, `providers/openai.md`, `providers/google.md`                                                        |

Naming: verbs match `MusicGenerator` (`generate`, `streamGeneration`).
Response naming matches the two newest capabilities (`RerankResponse`,
`EmbedResponse`): `ImageResponse`.

## Provider facts that drive the design

| Fact                       | OpenAI `gpt-image-2`                                                                                        | Gemini image models                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Endpoint                   | `POST {host}/images/generations` (JSON), `POST {host}/images/edits` (multipart or JSON)                     | `POST {base}/models/{model}:generateContent`, same as the LLM adapter                                                  |
| Size                       | `size: "WxH"`, any multiples of 16, ratio 1:3 to 3:1, max edge 3840, or `"auto"`                            | `imageConfig.aspectRatio` (14 ratios) + `imageSize` (`"512"`, `"1K"`, `"2K"`, `"4K"`; uppercase K)                     |
| Quality                    | `quality: low                                                                                               | medium                                                                                                                 | high                     | auto`            | None. Quality is the model choice (Lite, Flash, Pro) plus `imageSize` |
| Count                      | `n` 1..10                                                                                                   | `candidateCount` exists generically; behaviour on image models UNVERIFIED                                              |
| Reference images           | edits only: `images[]` up to 16, `image_url` (https or data URL) or `file_id`                               | `inlineData` parts in the prompt, 14 total, 20 MB inline cap                                                           |
| Mask                       | PNG with alpha, same dimensions, applies to first image                                                     | None. Prompt-only "semantic masking"                                                                                   |
| Output                     | Always `b64_json`; `url` never returned. `output_format` png / jpeg / webp                                  | `inlineData { mimeType, data }` part in the model turn, interleaved with text parts                                    |
| Streaming                  | `stream: true` + `partial_images` 0..3; SSE `image_generation.partial_image` / `.completed`                 | `streamGenerateContent?alt=sse`; whether a large image is split across chunks is UNVERIFIED                            |
| Usage                      | `usage.input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details { text_tokens, image_tokens }` | `usageMetadata` with `candidatesTokensDetails[{ modality: "IMAGE", tokenCount }]`; 1K image = 1120 output tokens       |
| Watermark                  | none documented                                                                                             | SynthID always; Lite adds C2PA                                                                                         |
| Content block              | HTTP error `code: "moderation_blocked"` with `moderation_details`                                           | `promptFeedback.blockReason` or `finishReason` in `IMAGE_SAFETY                                                        | IMAGE_PROHIBITED_CONTENT | IMAGE_RECITATION | IMAGE_OTHER                                                           | NO_IMAGE` |
| Latency                    | Up to 2 minutes on complex prompts                                                                          | Seconds                                                                                                                |
| Extras                     | `background: transparent` (png/webp), `moderation: low`, `output_compression`                               | `tools: [{ googleSearch: {} }]` (Flash and Pro), `thinkingConfig.thinkingLevel`, thought images when `includeThoughts` |
| Function calling alongside | n/a on Images API; the Responses tool coexists with function tools                                          | Not supported on image models                                                                                          |

Gemini stays on `generateContent`. Google's own docs say it "remains
fully supported" and is "the recommended path for stable deployments";
the Interactions API is beta, had a breaking change in May 2026, and
lacks Batch. The existing Gemini plumbing in `@effect-uai/google` is
reused as is.

## Design

### Surface 1: `ImageGenerator`

**Separate `generate` and `edit`.** Every vendor exposes edit as a
distinct endpoint or request shape and the required fields differ
(`images` is required on edit, absent on generate). One method with
conditionally required fields types badly. Same split as
`synthesize` / `synthesizeDialogue`.

**Aspect ratio and resolution tier, not pixels, on the common
request.** Gemini takes exactly these two fields. OpenAI takes `WxH`
but accepts any multiple of 16 within 1:3 to 3:1, so the adapter
derives `WxH` from ratio and tier deterministically (`1K` puts 1024 on
the short edge, `2K` 2048; long edge scaled and rounded to 16). A
caller who needs exact pixels on OpenAI sets `size` on the
provider-typed request, which overrides. Per guideline §2.3 the
adapter does not validate ratios or tiers per model; the provider's
400 is translated to `Unsupported`.

**No quality tier on the common request.** Gemini has none; its
quality axis is the model. OpenAI's `quality` is provider-typed.

**No `seed`, no `negativePrompt`.** Neither launch provider has them.

**Output is `ImageSource`.** Adapters return the base64 they received
with the MIME type derived from `output_format` (OpenAI) or
`inlineData.mimeType` (Gemini). No re-encoding. The same value is
accepted as `InputImage.source` on the next LLM call.

**`n`.** Common, default 1. Gemini fails `Unsupported` for `n > 1`
until `candidateCount` on image models is verified with one real
call, which is the first thing the Gemini adapter's manual test does.
This is bucket 1: fewer images than asked is structurally different
output.

**`streamGeneration`** is a method on the generic service, gated by
the `ImageStreaming` marker, exactly like `streamSynthesisFrom` and
`TtsIncrementalText`. It yields OpenAI partials then the final
response. OpenAI registers the marker; Gemini implements the method as
`Unsupported` and does not register it, so calling
`streamGeneration` against a Gemini-only layer is a compile-time
error.

**Errors.** Moderation and safety blocks map to
`AiError.ContentFiltered`. Gemini `NO_IMAGE` and an OpenAI response
with empty `data` map to `AiError.GenerationFailed`. Everything else
follows the existing `httpStatusError` / `transportFailure` helpers
and the provider error translation policy (capabilities-plan §1.3).

### Surface 2: image output in `LanguageModel` turns

Every provider models this as either an image part of the assistant
turn (Gemini) or a built-in tool whose result is an image (OpenAI
Responses, also xAI and Meta). Vercel AI SDK and LangChain keep both
inside the chat call with no separate abstraction. So does this
design.

**`OutputImage` content block** joins `ContentBlock`:
`{ type: "output_image", source: ImageSource }`. Gemini decodes each
non-thought `inlineData` part in a model turn into one; encodes a
model-role `OutputImage` back into an `inlineData` part on the next
turn, which is exactly how Google's multi-turn REST sample works.
Thought images (`thought: true`) are dropped, matching how thought
text is not a content block today.

**Two `TurnEvent` variants.** `ImageOutput { image: ImageSource;
partialIndex?: number }` carries a finished image or, when
`partialIndex` is set, an OpenAI partial. `ImageGenerationCall
{ status: "started" | "generating" | "completed" | "failed" }` mirrors
`WebSearchCall` for the OpenAI built-in tool so loops can render
progress. Gemini emits only `ImageOutput`.

**OpenAI Responses `image_generation` tool** is a `Tool.provider` in
`ResponsesTools`, `kind: "image_generation"`, config mirroring the
wire tool. Always send `model: "gpt-image-2"`; the wire default is a
deprecated model. The `image_generation_call` output item decodes into
an assistant `Message` holding one `OutputImage`, with the item id in
`providerData.responses` so the next turn re-sends
`{ type: "image_generation_call", id }` in `input` and keeps image
continuity. Stream events map to `ImageGenerationCall` status and
`ImageOutput` partials. `revised_prompt` goes into `providerData` as
well; it is not on the spec schema.

**Gemini request options.** `responseModalities`, `imageConfig`, and
`thinkingLevel` become optional fields on `GeminiRequest` next to
`thinkingBudget`. The image model ids join the `GoogleModel` union.
If the model is an image model and no `responseModalities` is set,
the adapter sends `["TEXT", "IMAGE"]`. `googleSearch` already has a
home in `GeminiTools`.

## First-cut TS contract

```ts
// packages/core/src/domain/Media.ts (moved from Music.ts; Music re-exports)
export type Watermark = "synthid" | "c2pa" | (string & {})

// packages/core/src/domain/Image.ts (additions)
export type AspectRatio =
  | "1:1"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:3"
  | "4:5"
  | "5:4"
  | "9:16"
  | "16:9"
  | "21:9"
  | "1:4"
  | "4:1"
  | "1:8"
  | "8:1"
  | (string & {})

/** Resolution tier, the short edge in pixels roughly. Gemini-native; OpenAI derives `WxH`. */
export type ImageResolution = "1K" | "2K" | "4K"

export type GeneratedImage = {
  readonly image: ImageSource
  /** Set when the provider applies one (Gemini: `"synthid"`). */
  readonly watermark?: Watermark
}
```

```ts
// packages/core/src/image-generator/ImageGenerator.ts

export type CommonImageGenerateRequest = {
  readonly prompt: string
  /** Each provider narrows this to its typed literal union. */
  readonly model: string
  readonly aspectRatio?: AspectRatio
  readonly resolution?: ImageResolution
  /** Default 1. Providers without multi-image output fail `Unsupported` for more. */
  readonly n?: number
}

export type CommonImageEditRequest = CommonImageGenerateRequest & {
  /** Reference images. Provider limits apply (OpenAI 16, Gemini 14). */
  readonly images: ReadonlyArray<ImageSource>
}

export type CommonStreamImageRequest = CommonImageGenerateRequest & {
  /** Number of preview frames before the final image. */
  readonly partialImages: 1 | 2 | 3
}

/** Optional throughout: OpenAI bills tokens, Gemini reports modality token counts. */
export type ImageUsage = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

export type ImageResponse = {
  readonly images: ReadonlyArray<GeneratedImage>
  readonly usage: ImageUsage
}

export type ImagePartial = { readonly image: ImageSource; readonly index: number }
export type ImageStreamEvent = ImagePartial | ImageResponse

export type ImageGeneratorService = {
  readonly generate: (
    request: CommonImageGenerateRequest,
  ) => Effect.Effect<ImageResponse, AiError.AiError>
  readonly edit: (request: CommonImageEditRequest) => Effect.Effect<ImageResponse, AiError.AiError>
  readonly streamGeneration: (
    request: CommonStreamImageRequest,
  ) => Stream.Stream<ImageStreamEvent, AiError.AiError>
}

export class ImageGenerator extends Context.Service<ImageGenerator, ImageGeneratorService>()(
  "@betalyra/effect-uai/ImageGenerator",
) {}

/** Marker: the layer can stream partial images. Registered by OpenAI only. */
export class ImageStreaming extends Context.Service<ImageStreaming, void>()(
  "@betalyra/effect-uai/capability/ImageStreaming",
) {}

export const generate = (request: CommonImageGenerateRequest) =>
  Effect.flatMap(ImageGenerator, (g) => g.generate(request))

export const edit = (request: CommonImageEditRequest) =>
  Effect.flatMap(ImageGenerator, (g) => g.edit(request))

export const streamGeneration = (
  request: CommonStreamImageRequest,
): Stream.Stream<ImageStreamEvent, AiError.AiError, ImageGenerator | ImageStreaming> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const g = yield* ImageGenerator
      yield* ImageStreaming
      return g.streamGeneration(request)
    }),
  )
```

```ts
// packages/providers/openai/src/OpenAIImageGenerator.ts

export type OpenAIImageModel = "gpt-image-2" | "gpt-image-2-2026-04-21" | (string & {})

type OpenAIImageKnobs = {
  /** Exact `WxH` or "auto". Overrides `aspectRatio` + `resolution`. */
  readonly size?: string
  readonly quality?: "low" | "medium" | "high" | "auto"
  readonly background?: "transparent" | "opaque" | "auto"
  readonly outputFormat?: "png" | "jpeg" | "webp"
  readonly outputCompression?: number
  readonly moderation?: "low" | "auto"
}

export type OpenAIImageGenerateRequest = Omit<CommonImageGenerateRequest, "model"> & {
  readonly model: OpenAIImageModel
} & OpenAIImageKnobs
export type OpenAIImageEditRequest = Omit<CommonImageEditRequest, "model"> & {
  readonly model: OpenAIImageModel
} & OpenAIImageKnobs & {
    /** PNG with alpha, same dimensions as `images[0]`. */
    readonly mask?: ImageSource
  }
export type OpenAIStreamImageRequest = Omit<CommonStreamImageRequest, "model"> & {
  readonly model: OpenAIImageModel
} & OpenAIImageKnobs

export type OpenAIImageGeneratorService = {
  readonly generate: (
    r: OpenAIImageGenerateRequest,
  ) => Effect.Effect<ImageResponse, AiError.AiError>
  readonly edit: (r: OpenAIImageEditRequest) => Effect.Effect<ImageResponse, AiError.AiError>
  readonly streamGeneration: (
    r: OpenAIStreamImageRequest,
  ) => Stream.Stream<ImageStreamEvent, AiError.AiError>
}

export class OpenAIImageGenerator extends Context.Service<
  OpenAIImageGenerator,
  OpenAIImageGeneratorService
>()("@betalyra/effect-uai/providers/openai/OpenAIImageGenerator") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  readonly region?: OpenAiRegion
}

/** Registers the typed tag, the generic tag, and `ImageStreaming`. */
export const layer: (
  cfg: Config,
) => Layer.Layer<
  OpenAIImageGenerator | ImageGenerator | ImageStreaming,
  never,
  HttpClient.HttpClient
>
// = Layer.mergeAll(Layer.effect(OpenAIImageGenerator, make(cfg)), Layer.effect(ImageGenerator, ...cast...), Layer.succeed(ImageStreaming, undefined))
```

`baseUrl` is the gateway hook: the same layer against
`https://api.x.ai/v1`, `https://api.meta.ai/v1`,
`https://router.requesty.ai/v1`, or the Vercel AI Gateway reaches
xAI, Meta, Requesty, and Vercel. Decoding keeps `created`, `usage`,
`url`, and `revised_prompt` optional so those hosts' subsets decode.
Whether those gateways honour `ImageStreaming` is not the layer's
promise; pessimistic registration applies only to models the layer
routes to, and the layer is OpenAI's.

```ts
// packages/providers/google/src/GeminiImageGenerator.ts

export type GeminiImageModel =
  "gemini-3.1-flash-image" | "gemini-3.1-flash-lite-image" | "gemini-3-pro-image" | (string & {})

type GeminiImageKnobs = {
  /** Sent as `imageConfig.imageSize`. Overrides the common `resolution`. */
  readonly imageSize?: "512" | "1K" | "2K" | "4K"
  readonly thinkingLevel?: "minimal" | "high"
  readonly googleSearch?: boolean
}

export type GeminiImageGenerateRequest = Omit<CommonImageGenerateRequest, "model"> & {
  readonly model: GeminiImageModel
} & GeminiImageKnobs
export type GeminiImageEditRequest = Omit<CommonImageEditRequest, "model"> & {
  readonly model: GeminiImageModel
} & GeminiImageKnobs

export type GeminiImageGeneratorService = {
  readonly generate: (
    r: GeminiImageGenerateRequest,
  ) => Effect.Effect<ImageResponse, AiError.AiError>
  readonly edit: (r: GeminiImageEditRequest) => Effect.Effect<ImageResponse, AiError.AiError>
  /** Always fails `Unsupported`; `ImageStreaming` is not registered. */
  readonly streamGeneration: ImageGeneratorService["streamGeneration"]
}

export class GeminiImageGenerator extends Context.Service<
  GeminiImageGenerator,
  GeminiImageGeneratorService
>()("@betalyra/effect-uai/providers/google/GeminiImageGenerator") {}

export type Config = { readonly apiKey: Redacted.Redacted; readonly baseUrl?: string }
export const layer: (
  cfg: Config,
) => Layer.Layer<GeminiImageGenerator | ImageGenerator, never, HttpClient.HttpClient>
```

```ts
// packages/core/src/domain/Items.ts (addition)
export const OutputImage = Schema.Struct({
  type: Schema.Literal("output_image"),
  source: ImageSource,
})
export const ContentBlock = Schema.Union([InputText, InputImage, OutputText, OutputImage, Refusal])

// packages/core/src/domain/Turn.ts (addition to TurnEvent)
ImageOutput: { readonly image: ImageSource; readonly partialIndex?: number }
ImageGenerationCall: { readonly status: "started" | "generating" | "completed" | "failed" }

// packages/providers/google/src/Gemini.ts (addition to GeminiRequest)
readonly responseModalities?: ReadonlyArray<"TEXT" | "IMAGE">
readonly imageConfig?: { readonly aspectRatio?: AspectRatio; readonly imageSize?: "512" | "1K" | "2K" | "4K" }
readonly thinkingLevel?: "minimal" | "low" | "medium" | "high"

// packages/providers/responses/src/ResponsesTools.ts (addition)
export type ImageGenerationOptions = {
  readonly model?: OpenAIImageModel          // sent as "gpt-image-2" when omitted
  readonly quality?: "low" | "medium" | "high" | "auto"
  readonly size?: string
  readonly background?: "transparent" | "opaque" | "auto"
  readonly outputFormat?: "png" | "jpeg" | "webp"
  readonly outputCompression?: number
  readonly moderation?: "low" | "auto"
  readonly partialImages?: 0 | 1 | 2 | 3
  readonly action?: "generate" | "edit" | "auto"
  readonly inputImageMask?: ImageSource
}
export const imageGenerationTool: (opts?: ImageGenerationOptions) => Tool.Provider
```

## Module layout

| Path                                                                           | Change                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/domain/Media.ts`, `Music.ts`                                | Move `Watermark` to `Media.ts`; `Music.ts` re-exports it.                                                                                                                                                               |
| `packages/core/src/domain/Image.ts`                                            | Add `AspectRatio`, `ImageResolution`, `GeneratedImage`.                                                                                                                                                                 |
| `packages/core/src/image-generator/ImageGenerator.ts`                          | New. Tag, marker, common types, helpers. Export `./ImageGenerator` in `package.json`.                                                                                                                                   |
| `packages/core/src/domain/Items.ts`                                            | Add `OutputImage`, `isOutputImage`; widen `ContentBlock`.                                                                                                                                                               |
| `packages/core/src/domain/Turn.ts`                                             | Add `ImageOutput`, `ImageGenerationCall` to `TurnEvent`.                                                                                                                                                                |
| `packages/providers/openai/src/OpenAIImageGenerator.ts`                        | New. Images API adapter, `resolveHost`, multipart and JSON edit bodies, SSE partials, registers `ImageStreaming`. Physical home is `openai`, same as the audio endpoints; the Images API is not the Responses protocol. |
| `packages/providers/openai/src/models.ts`                                      | Add `OpenAIImageModel`.                                                                                                                                                                                                 |
| `packages/providers/responses/src/ResponsesTools.ts`                           | Add `imageGenerationTool` and its config variant; render to the wire tool.                                                                                                                                              |
| `packages/providers/responses/src/codec.ts`, `Responses.ts`                    | `WireImageGenerationCall` output item; stream events; decode to `OutputImage` message with `providerData.responses.imageGenerationCallId`; re-encode on input. Re-export through `openai`.                              |
| `packages/providers/google/src/GeminiImageGenerator.ts`                        | New. `generateContent` adapter with `imageConfig`, reference images as `inlineData`, block reasons to `ContentFiltered`, `watermark: "synthid"`.                                                                        |
| `packages/providers/google/src/models.ts`                                      | Add `GeminiImageModel`; add the three ids to `GoogleModel`.                                                                                                                                                             |
| `packages/providers/google/src/codec.ts`, `Gemini.ts`                          | Decode non-thought `inlineData` model parts to `OutputImage`; encode back; `GeminiRequest` gains `responseModalities`, `imageConfig`, `thinkingLevel`.                                                                  |
| `docs/image-generation/index.md`, `providers/openai.md`, `providers/google.md` | Rewrite from "coming soon" to usage-POV; gateway section for xAI, Meta, Requesty, Vercel in the OpenAI provider page.                                                                                                   |
| `docs/migrations/v0-13.md`                                                     | Additive section.                                                                                                                                                                                                       |
| `recipes/storyboard`, `recipes/critique-and-regenerate`                        | Surface 1 recipes.                                                                                                                                                                                                      |
| `recipes/conversational-image-edit`, `recipes/ad-variant-matrix`               | Surface 2 recipe and the parallel-generation recipe.                                                                                                                                                                    |
| `webpage/`                                                                     | Capability count and card, recipe grid entries, icon map.                                                                                                                                                               |

## Resolved decisions

- Separate `generate` and `edit`.
- Aspect ratio plus resolution tier on the common request; pixels and
  quality are OpenAI-typed.
- No `seed`, no quality tier, no mask on the common request.
- `streamGeneration` on the generic service, gated by `ImageStreaming`.
- No client-side per-model validation; translate provider errors.
- Gemini via `generateContent`, not Interactions.
- Image output in LLM turns is a `ContentBlock` and two `TurnEvent`s,
  not a separate service.
- OpenAI Images adapter lives in `@effect-uai/openai`; the Responses
  built-in tool lives in `@effect-uai/responses`.
- Gateways (xAI, Meta, Requesty, Vercel) are a `baseUrl` and a docs
  section. No packages. OpenRouter deferred.

## Open items for implementation

1. Verify `candidateCount > 1` on Gemini image models with one real
   call. Until then `n > 1` fails `Unsupported`.
2. Verify whether `streamGenerateContent` splits a 4K `inlineData`
   across chunks. Decode defensively either way: concatenate
   consecutive `inlineData` parts with the same MIME type inside one
   candidate.
3. Confirm the JSON edit body accepts arbitrary `WxH` on gpt-image-2.
   Send a plain string; fall back to multipart if the server rejects.
4. Confirm OpenAI's 400 for out-of-range `size` carries a message the
   error translation layer can map to `Unsupported` rather than
   `InvalidRequest`.

## Implementation order

Each step is independently shippable; tests against mocks at every
step, one manual run against the real API per adapter.

1. Core: `Watermark` move, `Image.ts` additions, `ImageGenerator` tag
   and marker, docs page skeleton.
2. `OpenAIImageGenerator` (generate, edit, mask, `streamGeneration`).
3. `GeminiImageGenerator`.
4. Recipes `storyboard`, `critique-and-regenerate`.
5. `OutputImage`, `TurnEvent` variants, Gemini native image output,
   Responses `image_generation` tool.
6. Recipes `conversational-image-edit`, `ad-variant-matrix`.
7. Provider docs, gateway docs, migration doc, landing page.

Steps 1 to 4 are a complete v0.13 item. Step 5 is the slip candidate.
If it slips, `conversational-image-edit` slips with it.

**As built (2026-09-05).** The critique loop folded into `storyboard`
rather than becoming its own recipe. `ad-variant-matrix` was dropped:
parallel fan-out is `Effect.forEach` and two recipes already show it.
Step 5 shipped its Gemini half; the Responses `image_generation` tool is
deferred, and is a hosted tool call rather than native image output.
Step 8's `@effect-uai/fal` landed without streaming. Rationale for each
is in [research/image-generation.md](./research/image-generation.md).

## Open

Not blocking the release. In rough priority order.

### `Turn.imagesAsInput` should be per-item, and named for media

The exported signature is `(history) => history`, but the body is a
`flatMap` and the transformation is item-local, so the array shape only
takes control away from the caller. A per-item
`(item: HistoryItem) => ReadonlyArray<HistoryItem>` composes with
`flatMap` for the whole history and lets a caller convert only the last
turn, which is the common want when five turns each drew something.
Drop the array version rather than shipping both.

The name should also be about media rather than direction.
`outputAsInput` reads as the general rule but is wrong for
`output_text` and `refusal`: those are assistant content every provider
replays, and converting them would be a bug. The actual rule is "media
the assistant produced that this provider cannot carry on an assistant
turn". Something like `mediaAsInput` says that.

Getting the signature right now is what makes the modality question
additive later: with a per-item shape, `output_audio` is a new branch in
the body rather than a rename. Designing a generic mapping today would
be a table with one entry, and we do not know what audio-in-a-turn looks
like, since realtime audio is deliberately out of turns.

Cost of deferring: the name is already in the docs, the migration entry,
the skill, and the spike, so it gets more expensive after a release.

### fal reference-field discovery: proven, table removed

`fal-ai/qwen-image-edit`, `fal-ai/flux/dev/image-to-image` and
`fal-ai/flux-general/image-to-image` all refuse `image_urls` and name
`image_url` in the 422, and the adapter's own parser reads it back
correctly from each. Discovery is the only mechanism now; the lookup
table it backed up was removed, since the correction costs one
sub-second validation round trip that is cached per endpoint.

`fal-ai/uso` hung rather than answering and is still unmeasured. Probe
with `experiments/fal-reference-field`.

### No tests for the new core helpers

`imagesAsInput` and `Capabilities.warnDroppedBlocks` are pure with real
branching, which is the kind worth covering. The provider codecs are
not: those need a live call, as this build repeatedly showed.

### `providerData` on `ImageResponse`

There is no passthrough slot on an image result, so per-image dimensions
and provider extras have nowhere to go. Only worth opening when someone
asks for them.

### Responses `image_generation` tool

Deferred above; listed here so it is not lost. Needs OpenAI credits or a
gateway that proxies hosted tools.

## Sources

Wire schemas: [openai-wire.md](./research/image-generation/openai-wire.md),
[gemini-wire.md](./research/image-generation/gemini-wire.md).
Landscape, categories, routers, recipes:
[research/image-generation.md](./research/image-generation.md).
Capability policy: [capabilities-plan.md](./capabilities-plan.md).
