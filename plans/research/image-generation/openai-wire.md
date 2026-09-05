# Subagent report: OpenAI image generation wire schemas, gpt-image-2 (2026-09-04)

Raw research report. Summarised in
[../image-generation.md](../image-generation.md) and used by
[../../image-generation.md](../../image-generation.md).

**Sources**: OpenAPI spec `openai/openai-openapi@master` (v2.3.0; `manual_spec` branch has 0 hits for gpt-image-2, so it's stale), [images/create](https://developers.openai.com/api/docs/api-reference/images/create), [images/createEdit](https://developers.openai.com/api/docs/api-reference/images/createEdit), [images-streaming](https://developers.openai.com/api/docs/api-reference/images-streaming), [image-generation guide](https://developers.openai.com/api/docs/guides/image-generation), [tools-image-generation](https://developers.openai.com/api/docs/guides/tools-image-generation), [responses ref](https://developers.openai.com/api/docs/api-reference/responses), [models/gpt-image-2](https://developers.openai.com/api/docs/models/gpt-image-2), [pricing](https://developers.openai.com/api/docs/pricing). All rendered fine.

**Model ids**: `gpt-image-2` (alias) and snapshot `gpt-image-2-2026-04-21`. No mini variant exists anywhere in the spec or docs. Supported endpoints: `/v1/images/generations`, `/v1/images/edits`, `/v1/batch`; feature: inpainting.

## 1. `POST /v1/images/generations` (JSON) `CreateImageRequest`

```ts
{
  prompt: string,                       // required, max 32000 chars
  model?: "gpt-image-2" | "gpt-image-2-2026-04-21" | string,  // spec default dall-e-2 "unless a GPT-image-specific param is used"; always send it
  n?: number | null,                    // int 1..10, default 1
  size?: string | null,                 // default "auto"; see rules
  quality?: "auto" | "low" | "medium" | "high" | null,  // default auto
  background?: "transparent" | "opaque" | "auto" | null, // default auto; transparent is "in preview" for gpt-image-2, requires png|webp
  output_format?: "png" | "jpeg" | "webp" | null,        // default png
  output_compression?: number | null,   // int 0..100, default 100; jpeg/webp only
  moderation?: "low" | "auto" | null,   // default auto
  stream?: boolean | null,              // default false
  partial_images?: number | null,       // int 0..3, default 0 (0 = single final event)
  user?: string
}
```

`size` for gpt-image-2 (only model with arbitrary sizes): any `"${W}x${H}"` with both divisible by 16, aspect between 1:3 and 3:1, max edge <= 3840 (max `3840x2160`; above `2560x1440` is "experimental"), total pixels 655,360..8,294,400 (guide). Named examples: `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840`, `auto`.

Not applicable to gpt-image-2: `response_format`, `style` (dall-e only), `input_fidelity` does not exist on generations. Guide: "For gpt-image-2, omit `input_fidelity`; the API doesn't allow changing it because the model processes every image input at high fidelity automatically."

## 2. `POST /v1/images/edits`

Two content types (spec path description): `multipart/form-data` with `image`/`mask` binaries, or `application/json` (`EditImageBodyJsonParam`) with `images`/`mask` references. "JSON edits support GPT image models only."

Multipart `CreateImageEditRequest`: required `prompt`, `image`. `image` is one file or an array (`-F "image[]=@a.png"` repeated), max 16 items; each png/webp/jpg < 50MB. `mask`: PNG < 4MB, same dimensions as `image`, must contain an alpha channel; fully transparent pixels mark the edit region; applied to the first image only. Other fields as in §1 (`model` default here is `gpt-image-1.5`; `size` default `1024x1024` in multipart, `auto` in JSON; `quality`, `background`, `output_format`, `output_compression`, `stream`, `partial_images`, `user`) plus `input_fidelity?: "high" | "low" | null` (omit for gpt-image-2, see above). Note: multipart schema has no `moderation`; JSON variant does.

JSON body:

```ts
type ImageRef = { image_url: string } | { file_id: string }  // exactly one; image_url = https URL or data URL, maxLength 20971520
{
  images: ImageRef[],                   // required, 1..16
  mask?: ImageRef,
  prompt: string,                       // 1..32000 (spec marks only images required)
  model?, n?, quality?, input_fidelity?, size?: "auto"|"1024x1024"|"1536x1024"|"1024x1536"|null,
  output_format?, output_compression?, moderation?, background?, stream?, partial_images?, user?
}
```

The JSON `size` enum is closed in the spec, but the docs say arbitrary sizes apply to gpt-image-2 edits too (UNVERIFIED for the JSON variant specifically; send a plain string).

## 3. Response `ImagesResponse` (both endpoints)

```ts
{
  created: number,                      // unix seconds; only required field
  data: Array<{ b64_json?: string, url?: string, revised_prompt?: string }>,
  background?: "transparent" | "opaque",
  output_format?: "png" | "webp" | "jpeg",
  size?: string,                        // spec enum 1024x1024|1024x1536|1536x1024, but gpt-image-2 returns arbitrary WxH (UNVERIFIED; model as string)
  quality?: "low" | "medium" | "high",
  usage?: {
    input_tokens: number, output_tokens: number, total_tokens: number,
    input_tokens_details: { text_tokens: number, image_tokens: number },
    output_tokens_details?: { image_tokens: number, text_tokens: number }  // present in ImageGenUsage, absent from ImagesUsage (streaming)
  }
}
```

`url` is never returned for GPT image models ("always return base64-encoded images"; `url` "Unsupported for the GPT image models"). `revised_prompt` is documented as dall-e-3 only on this endpoint. So for gpt-image-2 decode `data[i].b64_json` as required in practice, keep `url`/`revised_prompt` optional.

## 4. Images API streaming (SSE, `stream: true`)

Discriminator `type`. All fields below are required in the spec.

```ts
// image_generation.partial_image | image_edit.partial_image
{ type, b64_json: string, created_at: number, partial_image_index: number,
  size: string, quality: "low"|"medium"|"high"|"auto",
  background: "transparent"|"opaque"|"auto", output_format: "png"|"webp"|"jpeg" }

// image_generation.completed | image_edit.completed
{ type, b64_json: string, created_at: number, size, quality, background, output_format,
  usage: { total_tokens, input_tokens, output_tokens, input_tokens_details: { text_tokens, image_tokens } } }
```

Spec enum for `size` here is again the 3 fixed sizes + `auto`; model as string for gpt-image-2. Final image may arrive before all `partial_images` are emitted. Error events use the generic `{ event: "error", data: ... }` (UNVERIFIED for images specifically).

## 5. Responses API `image_generation` tool

`ImageGenTool` (only `type` required):

```ts
{
  type: "image_generation",
  model?: "gpt-image-1"|"gpt-image-1-mini"|"gpt-image-1.5"|"gpt-image-2"|"gpt-image-2-2026-04-21"|"chatgpt-image-latest"|string, // default gpt-image-1, so set it explicitly
  quality?: "low"|"medium"|"high"|"auto",     // auto
  size?: string,                              // "1024x1024"|"1024x1536"|"1536x1024"|"auto" or arbitrary WxH for gpt-image-2; default auto
  background?: "transparent"|"opaque"|"auto", // auto
  input_fidelity?: "high"|"low"|null,
  input_image_mask?: { image_url?: string /* base64 data URL */, file_id?: string },
  output_format?: "png"|"webp"|"jpeg",        // png
  output_compression?: number,                // 0..100, default 100
  moderation?: "auto"|"low",                  // auto
  partial_images?: number,                    // 0..3, default 0
  action?: "generate"|"edit"|"auto"           // auto
}
```

Output item `ImageGenToolCall` (also accepted as an input item):

```ts
{ type: "image_generation_call", id: string,
  status: "in_progress"|"completed"|"generating"|"failed",
  result: string | null,           // base64 image
  revised_prompt?: string }        // in docs examples, NOT in the spec schema; model optional
```

Docs mention `output_format`/`size`/`quality`/`background` on the item in some examples: UNVERIFIED, keep optional.

Streaming events (`type`, `output_index: number`, `item_id: string`, `sequence_number: number` required on all): `response.image_generation_call.in_progress`, `.generating`, `.completed`, and `.partial_image` which adds required `partial_image_index: number`, `partial_image_b64: string` plus optional `size`, `quality`, `background`, `output_format` (all plain strings). Final image is in the `image_generation_call` item of `response.completed`.

Multi-turn: either `previous_response_id`, or put `{ type: "image_generation_call", id: "ig_..." }` in `input`. Input images for edits: `input` content items `{ type: "input_image", image_url?: string | null, file_id?: string | null, detail: "low"|"high"|"auto"|"original" }` (`detail` is required in the spec, default `auto`). Mask goes via the tool's `input_image_mask`. The `store: false` caveat is not present in current docs (UNVERIFIED; behaviour when items aren't stored is undocumented now). Mainline models supporting the tool: gpt-5.5, gpt-5.4-mini, gpt-5.4-nano, gpt-5.2, gpt-5, gpt-5-nano, o3, gpt-4.1(-mini/-nano), gpt-4o(-mini). Image models are not valid as the top-level `model`. The mainline model rewrites the prompt; the rewrite is exposed as `revised_prompt`.

## 6. Pricing, limits (gpt-image-2)

Per 1M tokens, standard: text input $5.00, image input $8.00, cached input $2.00, image output $30.00. Batch: $2.50 / $4.00 / $1.00 / $15.00. The pricing page no longer lists per-image prices (defers to a calculator). Third-party estimates, UNVERIFIED: 1024x1024 roughly $0.01-0.02 low, ~$0.053 medium, ~$0.17-0.21 high ([WaveSpeed](https://wavespeed.ai/blog/posts/gpt-image-2-pricing-2026/), [gathos](https://gathos.com/blog/gpt-image-2-api-pricing)). Rate limits (TPM / images per minute): Tier 1 100k/5, Tier 2 250k/20, Tier 3 800k/50, Tier 4 3M/150, Tier 5 8M/250. Complex prompts can take up to 2 minutes; set HTTP timeouts accordingly.

## 7. Errors

Generic `Error` object: `{ code: string | null, message: string, param: string | null, type: string }`. Moderation block (guide):

```json
{ "error": { "type": "image_generation_user_error", "code": "moderation_blocked",
  "message": "...",
  "moderation_details": { "moderation_stage": "input" | "output" | "unknown",
                          "categories": ["harassment", "self-harm", "sexual", "violence"] } } }
```

`moderation_details` is optional and not in the OpenAPI `Error` schema (docs only). In Responses, a blocked tool call surfaces as `status: "failed"` on the item (UNVERIFIED exact error placement).
