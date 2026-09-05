# Subagent report: Gemini native image generation wire schemas (2026-09-04)

Raw research report. Summarised in
[../image-generation.md](../image-generation.md) and used by
[../../image-generation.md](../../image-generation.md).

## Summary answer: stay on `generateContent` / `streamGenerateContent`

Evidence:

- Interactions overview: "The original `generateContent` API remains fully supported" and, under Limitations: "For production workloads, you should continue to use the standard `generateContent` API. It remains the recommended path for stable deployments, and we will continue to actively develop and maintain it." Batch API is listed as _not yet available_ in Interactions. (https://ai.google.dev/gemini-api/docs/interactions)
- The Interactions version of the image page carries a banner: "This version of the page covers the new Interactions API, which is currently in Beta. For stable production deployments, we recommend you continue to use the `generateContent` API." (https://ai.google.dev/gemini-api/docs/interactions/image-generation)
- Interactions had a schema-breaking change in May 2026 (`outputs` to `steps`, `response_format` polymorphic) and requires an `Api-Revision: 2026-05-20` header. (https://ai.google.dev/gemini-api/docs/interactions-breaking-changes-may-2026)
- "Legacy" in the page title means "older API surface", not deprecated. Model cards list all three models with Image generation, Thinking, Batch supported and no deprecation. Deprecations page: `gemini-3.1-flash-image` and `gemini-3-pro-image` "No shutdown date announced". (https://ai.google.dev/gemini-api/docs/deprecations)

## Model ids

Stable, GA ids: `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`. The `-preview` ids (`gemini-3.1-flash-image-preview`, `gemini-3-pro-image-preview`) were shut down June 25, 2026; do not ship them. The Interactions reference also lists an alias `nano-banana-pro-preview` ("Gemini 3 Pro Image Preview"), which is not on any model card; treat as UNVERIFIED/legacy. (https://ai.google.dev/api/interactions-api)

## 1. generateContent request

Docs REST examples now use `/v1/models/{model}:generateContent`; `/v1beta` also carries every field below in the reference.

```json
{
  "contents": [
    { "role": "user", "parts": [
      { "text": "..." },
      { "inlineData": { "mimeType": "image/png", "data": "<base64>" } },
      { "fileData": { "mimeType": "video/mp4", "fileUri": "https://..." } }
    ]}
  ],
  "tools": [{ "googleSearch": {} }],
  "generationConfig": {
    "responseModalities": ["TEXT", "IMAGE"],
    "imageConfig": { "aspectRatio": "16:9", "imageSize": "2K" },
    "thinkingConfig": { "thinkingLevel": "HIGH", "includeThoughts": true },
    "candidateCount": 1
  },
  "safetySettings": [ ... ]
}
```

- `responseModalities[]`: enum `Modality` = `MODALITY_UNSPECIFIED | TEXT | IMAGE | VIDEO | AUDIO | DOCUMENT`. "Exact match to the modalities of the response"; unsupported combos return an error. Docs use `["TEXT","IMAGE"]` and `["IMAGE"]`; omitting it also works in current examples (model defaults to image+text).
- `imageConfig` (reference, string fields): `aspectRatio` in `1:1, 1:4, 4:1, 1:8, 8:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9` (default: model chooses based on reference images); `imageSize` in `"512" | "1K" | "2K" | "4K"`, default `1K`. Uppercase K required; `512` has no suffix; `1k` rejected. "An error will be returned if this field is set for models that don't support these config options."
- Newer alternative, same request: `generationConfig.responseFormat.image` (`ImageResponseFormat`): `mimeType` enum (`IMAGE_JPEG` only), `delivery` (`INLINE | URI`), `aspectRatio` enum (`ASPECT_RATIO_ONE_BY_ONE` ...), `imageSize` enum (`IMAGE_SIZE_FIVE_TWELVE | IMAGE_SIZE_ONE_K | IMAGE_SIZE_TWO_K | IMAGE_SIZE_FOUR_K`). The legacy docs REST samples pass short strings (`"aspectRatio": "16:9", "imageSize": "2K"`) into `responseFormat.image`, contradicting the enum names in the reference; whether the server accepts both spellings is UNVERIFIED. Recommendation: codec on `imageConfig` (unambiguous strings), optionally model `responseFormat.image` as a second schema.
- `thinkingConfig`: `thinkingLevel` enum `THINKING_LEVEL_UNSPECIFIED | MINIMAL | LOW | MEDIUM | HIGH`, `includeThoughts: boolean`, `thinkingBudget: integer`. Image models: thinking "enabled by default and cannot be disabled". 3.1 Flash Image: default `minimal`, supports `minimal`/`high`. 3.1 Flash Lite Image: `minimal`/`high` (default minimal). Pro: thinking supported; level control not documented (UNVERIFIED). Docs samples write `"thinkingLevel": "High"` (mixed case); proto enum is `HIGH`.
- `tools: [{ googleSearch: {} }]` with image output: yes, documented for 3.1 Flash Image and Pro; not for Lite. Image Search (3.1 Flash only): `{ "googleSearch": { "searchTypes": { "webSearch": {}, "imageSearch": {} } } }` (`SearchTypes` object; `WebSearch`, `ImageSearch` are empty objects; web search default when unset). Function calling is "Not supported" on all three (so no `functionDeclarations`).
- `systemInstruction`: not shown in any image doc; UNVERIFIED for image models. `safetySettings`: standard field, nothing image-specific documented.
- Per model: Lite = `1K` only, 14 ratios; Flash = `512|1K|2K|4K`; Pro = `1K|2K|4K`.

Sources: https://ai.google.dev/api/generate-content, https://ai.google.dev/gemini-api/docs/generate-content/image-generation

## 2. generateContent response

```json
{
  "candidates": [{
    "content": { "role": "model", "parts": [
      { "thought": true, "text": "..." },
      { "thought": true, "inlineData": { "mimeType": "image/png", "data": "..." } },
      { "text": "Here is ..." },
      { "inlineData": { "mimeType": "image/png", "data": "<base64>" }, "thoughtSignature": "<base64>" }
    ]},
    "finishReason": "STOP",
    "groundingMetadata": { "searchEntryPoint": {...}, "groundingChunks": [...], "groundingSupports": [...] }
  }],
  "promptFeedback": { "blockReason": "...", "safetyRatings": [...] },
  "usageMetadata": {
    "promptTokenCount": 0, "candidatesTokenCount": 0, "thoughtsTokenCount": 0,
    "toolUsePromptTokenCount": 0, "cachedContentTokenCount": 0, "totalTokenCount": 0,
    "promptTokensDetails": [{ "modality": "IMAGE", "tokenCount": 0 }],
    "candidatesTokensDetails": [{ "modality": "IMAGE", "tokenCount": 1120 }],
    "cacheTokensDetails": [], "toolUsePromptTokensDetails": [], "serviceTier": "..."
  }
}
```

- `Part` fields: `thought: boolean`, `thoughtSignature: string (base64)`, `partMetadata`, `mediaResolution`, plus union `text | inlineData{mimeType,data} | fileData | functionCall | functionResponse | executableCode | codeExecutionResult | toolCall | toolResponse`. With `includeThoughts`, interim thought images arrive as `thought: true` parts with `inlineData` ("up to two interim images", not charged); "the last image within Thinking is also the final rendered image".
- `FinishReason` full enum: `FINISH_REASON_UNSPECIFIED, STOP, MAX_TOKENS, SAFETY, RECITATION, LANGUAGE, OTHER, BLOCKLIST, PROHIBITED_CONTENT, SPII, MALFORMED_FUNCTION_CALL, IMAGE_SAFETY, IMAGE_PROHIBITED_CONTENT, IMAGE_OTHER, NO_IMAGE, IMAGE_RECITATION, UNEXPECTED_TOOL_CALL, TOO_MANY_TOOL_CALLS, MISSING_THOUGHT_SIGNATURE, MALFORMED_RESPONSE, ESCALATION`.
- `totalTokenCount` = prompt + thoughts + candidates. Output image token counts: 512px 747, 1K 1120, 2K 1680, 4K 2520 (3.1 Flash; Lite 1K 1120).
- Streaming: `streamGenerateContent?alt=sse` is not discussed on any image page. Whether a 4K image arrives as one `inlineData` part in one chunk or split across chunks is UNVERIFIED; third-party docs claim a single part. Design the decoder to concatenate consecutive `inlineData` parts defensively.

## 3. Editing and multi-turn

- Reference images: `inlineData` parts alongside text in the same `contents[0].parts`. Inline request cap: 20 MB total (text + instructions + bytes); use Files API (`fileData`) beyond that. Input MIME types: `image/png, image/jpeg, image/webp, image/heic, image/heif` (from image-understanding; the Interactions reference additionally lists gif/bmp/tiff for `ImageContent`).
- Limits, 14 total: Lite up to 14 object images (no character/style); 3.1 Flash up to 10 objects + 4 characters; Pro up to 6 objects + 5 characters + 3 style refs. (Docs table columns are inconsistent between the two page versions about which of Flash/Pro gets the 3 style refs; the generateContent page assigns style refs to Pro, the Interactions page assigns them to Pro as well.)
- Video-to-image (3.1 Flash and Lite): YouTube URL or Files API video part.
- Multi-turn: documented REST resends full history, including the model turn as `{ "role": "model", "parts": [{ "inline_data": {...} }] }`. Thought signatures: Gemini 3 "may return thought signatures for all types of parts. We recommend you always pass all signatures back as received, but it's required for function calling signatures"; since image models have no function calling, echoing `thoughtSignature` is recommended, not mandatory (`MISSING_THOUGHT_SIGNATURE` exists as a finishReason). The docs' multi-turn REST sample omits it. (https://ai.google.dev/gemini-api/docs/generate-content/thinking)

## 4. Interactions alternative

`POST https://generativelanguage.googleapis.com/v1beta/interactions`, headers `x-goog-api-key`, `Api-Revision: 2026-05-20`.

```json
{
  "model": "gemini-3.1-flash-image",
  "input": [ { "type": "text", "text": "..." }, { "type": "image", "mime_type": "image/jpeg", "data": "<base64>" } ],
  "response_format": { "type": "image", "mime_type": "image/jpeg", "aspect_ratio": "16:9", "image_size": "2K" },
  "generation_config": { "thinking_level": "high" },
  "tools": [{ "type": "google_search", "search_types": ["web_search", "image_search"] }],
  "previous_interaction_id": "v1_...", "store": true, "stream": true, "background": false,
  "system_instruction": "...", "safety_settings": [...]
}
```

`response_format` image: `type: "image"`, `mime_type` (`image/jpeg` only), `delivery` (`inline|uri`), `aspect_ratio` (same 14 strings), `image_size` (`512|1K|2K|4K`); may be an array for multi-modality. `thinking_level`: `minimal|low|medium|high`. Response: `{ id, status, steps[], usage }`; `status` enum `in_progress | requires_action | completed | failed | cancelled | incomplete | budget_exceeded | queued`. Step types: `thought` (`signature`, `summary[]` of text/image blocks), `model_output` (`content[]` of `{type:"text"|"image", data, mime_type, resolution?, uri?}`), `google_search_call`, `google_search_result` (`search_suggestions`), `user_input`. `output_image` is an SDK-only convenience (last image block), not a wire field. Usage: `total_tokens, total_input_tokens, total_output_tokens, total_thought_tokens, total_tool_use_tokens, total_cached_tokens, *_by_modality[{modality:"text"|"image"|..., tokens}]`.

SSE: `event: interaction.created`, `interaction.status_update`, `step.start` (`{index, step:{type}}`), `step.delta` (`{index, delta:{type:"text"|"image"|"thought_summary"|"thought_signature"|...}}`; image delta = `{type:"image", mime_type, data}`), `step.stop`, `interaction.completed` (with `usage`), `error`. Whether image `data` is split across multiple `step.delta`s is not stated.

Extras over generateContent: server-side history via `previous_interaction_id` (retention 55 days paid, 1 day free), server-managed signatures, first-class thought steps, inline `url_citation` annotations, `uri` delivery, `background` mode. Missing: Batch API, explicit caching. Sources: https://ai.google.dev/api/interactions-api, https://ai.google.dev/gemini-api/docs/interactions/streaming

## 5. Capability table

|                            | 3.1 Flash Lite Image                                                                                                            | 3.1 Flash Image                                   | 3 Pro Image                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| Sizes                      | 1K only                                                                                                                         | 512, 1K, 2K, 4K (default 1K)                      | 1K, 2K, 4K (default 1K)                     |
| Aspect ratios              | 14 listed (no 1:4/4:1/1:8/8:1 per model card; API enum accepts 14 total) UNVERIFIED which of the extreme ratios Lite/Pro accept | all 14                                            | 14 minus the four extreme ratios UNVERIFIED |
| Reference images           | 14 objects                                                                                                                      | 10 obj + 4 char                                   | 6 obj + 5 char + 3 style                    |
| Thinking                   | yes (minimal/high)                                                                                                              | yes (minimal/high)                                | yes                                         |
| Search grounding           | no                                                                                                                              | yes, web + image search                           | yes, web                                    |
| Function calling           | no                                                                                                                              | no                                                | no                                          |
| Batch                      | yes                                                                                                                             | yes                                               | yes                                         |
| Input/output tokens        | 65,536 / 4,096                                                                                                                  | 131,072 / 32,768                                  | 65,536 / 32,768                             |
| Inputs                     | text, image, video, PDF                                                                                                         | text, image, video, PDF                           | image, text                                 |
| Price per image (standard) | $0.0336 (1K)                                                                                                                    | $0.045 / $0.067 / $0.101 / $0.151 (0.5K/1K/2K/4K) | $0.134 (1K/2K), $0.24 (4K)                  |
| Batch per image            | $0.0168                                                                                                                         | $0.022 / $0.034 / $0.050 / $0.076                 | $0.067 (1K/2K), $0.12 (4K)                  |
| Input $/1M                 | $0.25                                                                                                                           | $0.50                                             | $2.00                                       |
| Text/thinking out $/1M     | $1.50                                                                                                                           | $3                                                | $12                                         |

Search: 5,000 free requests/month shared across Gemini 3.x, then $14 per 1,000. Source: https://ai.google.dev/gemini-api/docs/pricing and the three model cards.

## 6. SynthID, personGeneration, candidateCount

- SynthID: "All generated images include a SynthID watermark"; Lite adds C2PA. No `imageConfig` field controls it (always on).
- `personGeneration`: not a field of `ImageConfig` or `ImageResponseFormat`; Imagen-only, drop it.
- `candidateCount`: generic `GenerationConfig` field ("default 1"). No image doc mentions n>1 for image models; UNVERIFIED whether it yields multiple images or errors.

## 7. Blocked-image shapes

- Prompt-level block: `candidates` absent, `promptFeedback.blockReason` in `BLOCK_REASON_UNSPECIFIED | SAFETY | OTHER | BLOCKLIST | PROHIBITED_CONTENT | IMAGE_SAFETY` plus `safetyRatings[]`.
- Output-level block: candidate present with `finishReason` in `IMAGE_SAFETY | IMAGE_PROHIBITED_CONTENT | IMAGE_RECITATION | IMAGE_OTHER | NO_IMAGE` and `content.parts` empty or text-only (exact part contents on block are not shown in docs; model `content` as optional/empty in the codec).
- HTTP 400 for invalid `imageSize` casing or `imageConfig` on unsupported models.

Pages that did not render for WebFetch: `https://ai.google.dev/api/interactions` (404; the reference lives at `https://ai.google.dev/api/interactions-api`), and the `/api/generate-content` HTML was truncated by the summarizer, so the `.md.txt` plain-text variants of every page were used for verbatim extraction.
