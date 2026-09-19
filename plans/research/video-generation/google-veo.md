# Subagent report: video generation, Google (Gemini Omni video and Veo) (2026-09-19)

Raw report, summarised in `../video-generation.md`.

All statements are from `ai.google.dev` (Gemini API) or `docs.cloud.google.com` (Gemini Enterprise Agent Platform, formerly Vertex AI) unless marked UNVERIFIED. Docs pages were read as raw markdown via the `<url>.md.txt` suffix, so quotes are verbatim from the published source.

---

## 1. Which API is current

### The recommendation, verbatim

From https://ai.google.dev/gemini-api/docs/video (the whole page is short, this is most of it):

> "The Gemini API offers two models for generating video, Gemini Omni Flash and Veo. Each are designed for different workflows.
>
> Use Gemini Omni Flash as your default model for video generation. It provides superior video coherence, multi-input reasoning (supporting text, images, audio, and video inputs simultaneously), character consistency, factual accuracy, and multi-turn conversational editing (e.g., element replacement or perspective changes). Use Veo 3.1 for specific capabilities like scene extension, last-frame control, or integration with legacy pipelines are required." (sic, the sentence is ungrammatical in the source)

So: **Gemini Omni Flash is the default; Veo 3.1 is the specialist / legacy path.** Veo is _not_ deprecated. `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview` and `veo-3.1-lite-generate-preview` all show "No shutdown date announced" on the deprecations page (https://ai.google.dev/gemini-api/docs/deprecations), and the Veo guide is still actively maintained (4K added 2026-01-13, Lite launched 2026-03-31). What _is_ superseded is the Veo 3.0 / 2.0 generation, which is shut down.

Note the positioning oddity: Omni is **GA and paid-only**, while all three Veo 3.1 ids on the Gemini API are still **Preview**. The GA Veo 3.1 ids live on the Gemini Enterprise Agent Platform (section 1.3).

### 1.1 Current model ids, Gemini API

| Model id (exact)                | Display name                | Status      | Release date      | Shutdown                                                      |
| ------------------------------- | --------------------------- | ----------- | ----------------- | ------------------------------------------------------------- |
| `gemini-omni-1.1-flash`         | Gemini Omni Flash           | Stable / GA | August 27, 2026   | "No shutdown date announced"                                  |
| `gemini-omni-flash-preview`     | Gemini Omni Flash (preview) | Preview     | June 30, 2026     | **September 30, 2026** (replace with `gemini-omni-1.1-flash`) |
| `veo-3.1-generate-preview`      | Veo 3.1                     | Preview     | October 15, 2025  | "No shutdown date announced"                                  |
| `veo-3.1-fast-generate-preview` | Veo 3.1 Fast                | Preview     | October 15, 2025  | "No shutdown date announced"                                  |
| `veo-3.1-lite-generate-preview` | Veo 3.1 Lite                | Preview     | March 31, 2026    | "No shutdown date announced"                                  |
| `veo-3.0-generate-001`          | Veo 3                       | Deprecated  | September 9, 2025 | **June 30, 2026** (shut down)                                 |
| `veo-3.0-fast-generate-001`     | Veo 3 Fast                  | Deprecated  | September 9, 2025 | **June 30, 2026** (shut down)                                 |
| `veo-2.0-generate-001`          | Veo 2                       | Deprecated  | April 9, 2025     | **June 30, 2026** (shut down)                                 |
| `veo-3.0-generate-preview`      | Veo 3 preview               | Shut down   | July 31, 2025     | November 12, 2025                                             |
| `veo-3.0-fast-generate-preview` | Veo 3 Fast preview          | Shut down   | July 31, 2025     | November 12, 2025                                             |

Dates from https://ai.google.dev/gemini-api/docs/deprecations and https://ai.google.dev/gemini-api/docs/changelog.

There is **no** `gemini-omni-1.1-pro`, no Omni "fast"/"lite" variant, and no Veo 4 on the Gemini API as of 2026-09-19. Omni Flash is the only Omni tier.

Quirk worth knowing for a model registry: the "All generative media models" table on https://ai.google.dev/gemini-api/docs/models lists `veo-3.1-generate-preview`, `veo-3.1-lite-generate-preview` and `gemini-omni-1.1-flash` but **omits `veo-3.1-fast-generate-preview`**, which is nonetheless documented on the Veo page, the deprecations page and the pricing page. Treat the models table as incomplete, not the Fast model as gone.

### 1.2 Changelog quotes for the transitions

August 27, 2026 (https://ai.google.dev/gemini-api/docs/changelog):

> "**Gemini Omni Flash generally available (GA)**: Released `gemini-omni-1.1-flash`, the GA version of our fast, conversational video generation and editing model. This release includes significant new capabilities:
>
> - **Video extension**: Seamlessly extend existing videos by generating continuations at the end of a clip using the `extend` task or directly with a prompt.
> - **Interpolation (first + last frame)**: Generate a video transitioning between two images using the `image_to_video` task with up to 2 images.
> - **Resolution control**: New `resolution` parameter in `video_config` supports `360p`, `720p` (default), `1080p`, and `4k` outputs. 1080p and 4K outputs are generated using upscaling.
>
> The existing `gemini-omni-flash-preview` endpoint will be deprecated on September 30, 2026."

June 30, 2026:

> "**Gemini Omni Flash in public preview**: Released `gemini-omni-flash-preview`, a high-performance multimodal model designed for high-speed video generation and conversational video editing. Using the Interactions API, you can generate 3--10 second videos at 720p from text descriptions or animate still images, and then conversationally edit and refine the outputs."

June 15, 2026 (Veo 3.0/2.0 deprecation announcement):

> "The following video generation models are being deprecated and will be shut down on **June 30, 2026**: `veo-2.0-generate-001`, `veo-3.0-generate-001`, `veo-3.0-fast-generate-001`. Update your integration to either use the Veo 3.1 preview model IDs (`veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`) or the 3.1 GA models available through the Gemini Enterprise Agent Platform to avoid service interruptions."

### 1.3 Gemini Enterprise Agent Platform (ex Vertex AI) ids

From https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate:

| Model id (exact)            | Launch stage | Release date      | Retirement                   |
| --------------------------- | ------------ | ----------------- | ---------------------------- |
| `veo-3.1-generate-001`      | GA           | November 17, 2025 | "November 17, 2026 or later" |
| `veo-3.1-fast-generate-001` | GA           | November 17, 2025 | "November 17, 2026 or later" |
| `veo-3.1-lite-generate-001` | Preview      | April 2, 2026     | not stated                   |

`veo-3.1-fast-generate-preview` also still appears on GEAP reference pages alongside the `-001` ids. No Gemini Omni video model is documented on GEAP as of this date (UNVERIFIED that it is absent; I did not exhaustively crawl GEAP, but the GEAP video model index reached from the Veo page lists only Veo).

---

## 2. Wire shape for each path

### 2.A Gemini Omni video: the Interactions API

**Endpoint** (https://ai.google.dev/gemini-api/docs/omni):

```
POST https://generativelanguage.googleapis.com/v1beta/interactions
```

Auth: the guide shows both `?key=$API_KEY` as a query parameter and `-H "x-goog-api-key: $GEMINI_API_KEY"` as a header, in different samples on the same page. Use the header.

**Synchronous by default.** The create call returns the finished `interaction` object with the video in it. There is no operation to poll for the generation itself. The docs' "Best practices" section confirms the unary mode is the intended fast path:

> "**Optimized performance:** Set `background=false`, `store=false`, and `stream=false` for faster, synchronous unary generation. Note that setting `store=false` means the generated video won't be editable in subsequent turns using the `previous_interaction_id`."

**Minimal request:**

```json
{
  "model": "gemini-omni-1.1-flash",
  "input": "A marble rolling fast on a chain reaction style track, continuous smooth shot."
}
```

**Full request shape** (fields assembled from the guide and https://ai.google.dev/api/interactions):

```json
{
  "model": "gemini-omni-1.1-flash",
  "previous_interaction_id": "v1_...",
  "input": [
    { "type": "text", "text": "..." },
    { "type": "image", "data": "<base64>", "mime_type": "image/jpeg" },
    { "type": "image", "uri": "https://generativelanguage.googleapis.com/v1beta/files/..." },
    { "type": "video", "uri": "...", "mime_type": "video/mp4" }
  ],
  "generation_config": {
    "video_config": { "task": "text_to_video" }
  },
  "response_format": {
    "type": "video",
    "aspect_ratio": "16:9",
    "resolution": "720p",
    "delivery": "inline"
  },
  "store": true,
  "background": false,
  "stream": false
}
```

The video-editing sample uses a nested wrapper form of `input` as well, with a `user_input` step carrying a `content` array. Both flat parts and `{"type":"user_input","content":[...]}` appear in official samples on the same page.

**How the video comes back.** Two modes, chosen by `response_format.delivery`:

1. `inline` (default, the guide's prose calls it `base64`): base64 MP4 bytes inside the `model_output` step. Google caps this at roughly 4 MB. "Use URI delivery for large videos: For videos larger than 4MB (>720p when available), use `delivery=\"uri\"` in `response_format` to avoid payload size limits."
2. `uri`: a Files API URI, which you then poll for `state == "ACTIVE"` and download.

Response, inline:

```json
{
  "steps": [
    { "type": "user_input", "content": [{ "type": "text", "text": "..." }] },
    { "type": "thought", "content": [{ "text": "...", "type": "thought" }] },
    {
      "type": "model_output",
      "content": [{ "type": "video", "mime_type": "video/mp4", "data": "AAAAIGZ0eXBpc29t..." }]
    }
  ],
  "id": "v1_...",
  "status": "completed",
  "model": "gemini-omni-1.1-flash",
  "object": "interaction"
}
```

Response, uri:

```json
{
  "steps": [
    {
      "type": "model_output",
      "content": [
        {
          "type": "video",
          "mime_type": "video/mp4",
          "uri": "https://generativelanguage.googleapis.com/v1beta/files/...:download?alt=media"
        }
      ]
    }
  ],
  "id": "v1_...",
  "status": "completed"
}
```

Then the URI path is a Files API poll plus download, exactly as in the official bash sample:

```
GET  https://generativelanguage.googleapis.com/v1beta/files/{FILE_ID}      -> {"state": "PROCESSING" | "ACTIVE" | "FAILED"}   (sample sleeps 5s)
GET  https://generativelanguage.googleapis.com/v1beta/files/{FILE_ID}:download?alt=media   -> MP4 bytes
```

**Trap for a client library**, quoted verbatim from the guide:

> "Currently, calling `GET /v1beta/interactions/{id}` returns the video as inline base64 data in the `data` field, even if the interaction was originally created with `delivery: \"uri\"`. The `uri` field is only guaranteed to be present in the initial creation response or Server-Sent Events (SSE) stream."

So a `VideoGenerator` cannot rely on re-reading the interaction to recover the URI. Capture it from the create response.

`interaction.output_video` is **SDK-only**: "The convenience field `interaction.output_video` is **SDK-only**. Get the video output from the `steps` array when using the REST API directly." Over raw HTTP you must walk `steps[]` for the `model_output` step and then its `content[]` for `type == "video"`.

**Retention.** Files API: "Files are automatically deleted after 48 hours" (https://ai.google.dev/gemini-api/docs/files). Interaction records: 55 days on the paid tier, 1 day on free, configurable to 7/14/28/55 days for paid projects (https://ai.google.dev/gemini-api/docs/interactions-overview). Those two clocks are independent: the interaction record outlives the file.

### 2.B Veo: `predictLongRunning` plus operation polling

Base URL `https://generativelanguage.googleapis.com/v1beta`. Auth header `x-goog-api-key: $GEMINI_API_KEY`.

```
POST {BASE_URL}/models/veo-3.1-generate-preview:predictLongRunning     -> {"name": "models/veo-3.1-generate-preview/operations/..."}
GET  {BASE_URL}/{operation_name}                                       -> {"done": false} ... {"done": true, "response": {...}}
GET  {video_uri}   (with x-goog-api-key, follow redirects)             -> MP4 bytes
```

**Polling cadence:** every official REST sample on the Veo page uses `sleep 10`. One sample has a stale comment reading "Wait for 5 seconds before checking again" above a `sleep 10`; the actual cadence in all samples is 10 seconds.

**Done shape.** The REST samples extract with `jq -r '.response.generateVideoResponse.generatedSamples[0].video.uri'`, so on the Gemini API the payload is:

```
operation.response.generateVideoResponse.generatedSamples[0].video.uri
```

The Python/Go SDK samples use the camel-normalised `operation.response.generated_videos[0].video`, which is the same thing through the SDK. The Gemini API returns a **URI, not bytes**.

**The download needs the API key.** `curl -L -o out.mp4 -H "x-goog-api-key: $GEMINI_API_KEY" "${video_uri}"`. Redirects must be followed (`-L`). This is the Files API download surface, so it is a second authenticated request, not a public signed URL.

**Retention, verbatim:**

> "**Video retention:** Generated videos are stored on the server for 2 days, after which they are removed. To save a local copy, you must download your video within 2 days of generation. Extended videos are treated as newly generated videos."

and, for extension inputs:

> "Videos are stored for 2 days, but if a video is referenced for extension, its 2-day storage timer resets. You can only extend videos that were generated or referenced in the last two days."

**Docs inconsistency to be aware of.** The Veo page opens with:

> "**Note:** This feature is currently only available with the generateContent API. Please follow the content on this page for more information."

and https://ai.google.dev/gemini-api/docs/video says Veo 3.1 supports its features "through the `generateContent` API". Every actual sample on the page posts to `:predictLongRunning`. Read the note as "Veo is on the legacy `models/*` surface, not the Interactions API", not as a literal claim that `generateContent` generates video. **Implement against `predictLongRunning`.**

### 2.C Vertex / GEAP differences for Veo

Endpoint is per-project and per-region, and polling is a POST, not a GET:

```
POST https://us-central1-aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/us-central1/publishers/google/models/{MODEL_ID}:predictLongRunning
POST https://us-central1-aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/us-central1/publishers/google/models/{MODEL_ID}:fetchPredictOperation
     body: {"operationName": "projects/.../operations/{OPERATION_ID}"}
```

Auth is OAuth (`Authorization: Bearer $(gcloud auth print-access-token)`), not an API key. Output goes to a GCS bucket via `storageUri`, or comes back as base64 if omitted: "The Cloud Storage bucket to store the output videos. If not provided, a Base64-bytes encoded video is returned in the response." Region availability for Veo 3.1 is "United States: us-central1" only.

---

## 3. All request parameters

### 3.A Gemini Omni Flash

Omni deliberately has **very few knobs**. Duration, camera, audio and negatives are all prompt-level, not fields.

| Knob                      | Where                                                             | Values                                                                    | Notes                                                                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prompt                    | `input[].text` or `input` as a plain string                       | free text                                                                 | context window 1,048,576 tokens                                                                                                                                                                     |
| image (first frame)       | `input[]` part `{"type":"image", ...}`                            | base64 `data` + `mime_type`, or Files `uri`                               | 1 image = image-to-video                                                                                                                                                                            |
| last frame                | second `image` part in `input[]`                                  | as above                                                                  | "up to 2 images" with `image_to_video` gives interpolation                                                                                                                                          |
| reference images          | more `image` parts                                                | multiple; docs show 2 subject images, no hard cap stated for images       | UNVERIFIED max count for image references                                                                                                                                                           |
| video input               | `input[]` part `{"type":"video", "uri": ...}`                     | Files API upload preferred                                                | used for `edit` and `extend`                                                                                                                                                                        |
| video references          | `input[]`                                                         | "maximum of 3 clips, up to 3 seconds each"                                | audio in a video reference is ignored                                                                                                                                                               |
| `task`                    | `generation_config.video_config.task`                             | `text_to_video`, `image_to_video`, `reference_to_video`, `edit`, `extend` | optional, model infers otherwise; docs advise prompting first because "using the `task` field adds strict constraints"                                                                              |
| `aspect_ratio`            | `response_format`                                                 | `"16:9"` (default), `"9:16"`                                              | only two values                                                                                                                                                                                     |
| `resolution`              | `response_format`                                                 | `"360p"`, `"720p"` (default), `"1080p"`, `"4k"`                           | 1080p and 4K are **upscaled**, per the changelog and the guide table ("1080p output (upscaled)", "4K output (upscaled)")                                                                            |
| `delivery`                | `response_format`                                                 | `inline` (default), `uri`                                                 | API reference spells the values `inline`/`uri`; the guide prose says `base64`/`uri`, the guide's samples use `uri`                                                                                  |
| `duration`                | `response_format` (`VideoResponseFormat.duration`, type `string`) | not documented                                                            | Present in the API reference at https://ai.google.dev/api/interactions but **absent from the guide, which never sets it**. Allowed values UNVERIFIED. Output range is 3s to 10s per the model card. |
| `previous_interaction_id` | top level                                                         | prior interaction id                                                      | carries the video state for multi-turn edit/extend                                                                                                                                                  |
| `store`                   | top level                                                         | bool, default `true`                                                      | `store=false` breaks multi-turn editing and background execution                                                                                                                                    |
| `background`              | top level                                                         | bool                                                                      | docs recommend `false` for video                                                                                                                                                                    |
| `stream`                  | top level                                                         | bool                                                                      | see section 6                                                                                                                                                                                       |

**Explicitly unsupported on Omni**, verbatim from the Limitations section:

> "System instructions, temperature, `top_p`, stop sequences, and negative prompts are not supported (you can put your negatives in the regular prompt: e.g., \"Do not do X\")."

Also unsupported: audio reference uploads, voice editing, YouTube URLs as a media source, provisioned throughput, and multi-video reasoning. There is **no** `seed`, no `numberOfVideos`, no `personGeneration`, no `generateAudio`, no `fps`, no `enhancePrompt`, no `durationSeconds` on the Omni path.

Fixed output characteristics: 24 FPS, MP4, 3s to 10s (model card, https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash).

### 3.B Veo 3.1 on the Gemini API

Verbatim from the "Veo API parameters and specifications" table on https://ai.google.dev/gemini-api/docs/veo:

| Parameter                     | Veo 3.1 and Veo 3.1 Fast                                                                                                         | Veo 3.1 Lite                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `prompt` (instances)          | `string`, 1,024 token limit                                                                                                      | same                                                                                                     |
| `image` (instances)           | `Image` object                                                                                                                   | `Image` object                                                                                           |
| `lastFrame` (instances)       | `Image` object, "Must be used in combination with the `image` parameter"                                                         | `Image` object                                                                                           |
| `referenceImages` (instances) | `VideoGenerationReferenceImage` object, "Up to three images to be used as style and content references"                          | **n/a**                                                                                                  |
| `video` (instances)           | `Video` object from a previous generation                                                                                        | **n/a**                                                                                                  |
| `aspectRatio`                 | `"16:9"` (default), `"9:16"`                                                                                                     | same                                                                                                     |
| `durationSeconds`             | `"4"`, `"6"`, `"8"`. Must be `"8"` with extension, reference images, 1080p or 4k                                                 | `"4"`, `"6"`, `"8"`. Must be `"8"` with reference images or 1080p                                        |
| `resolution`                  | `"720p"` (default), `"1080p"` (8s only), `"4k"` (8s only); `"720p"` only for extension                                           | `"720p"` (default), `"1080p"` (8s only)                                                                  |
| `personGeneration`            | text-to-video and extension: `"allow_all"` only. Image-to-video, interpolation, reference images: `"allow_adult"` only           | text-to-video: `"allow_all"` only. Image-to-video, interpolation, reference images: `"allow_adult"` only |
| `seed`                        | "Note that the `seed` parameter is also available for Veo 3 models. It doesn't guarantee determinism, but slightly improves it." | listed N/A for Lite in the derived table                                                                 |

Note the values are **strings** for `durationSeconds`, not integers, on the Gemini API.

The `seed` sentence is ambiguous: it says "Veo 3 models", and Veo 3.0 is shut down. Whether `seed` is accepted on `veo-3.1-*-preview` is **UNVERIFIED** from the Gemini docs. On Vertex it is clearly documented (uint32, 0 to 4294967295).

**Not present in the Gemini API Veo table:** `negativePrompt`, `generateAudio`, `enhancePrompt`, `fps`, `compressionQuality`, `storageUri`. The one oddity: the official extension REST sample sets `"numberOfVideos": 1` in `parameters` even though `numberOfVideos` does not appear in the parameters table, and the model features table says "Videos per request: 1" for every variant. Treat `numberOfVideos` as accepted-but-pinned-to-1 on the Gemini API. (Vertex calls the same thing `sampleCount`, range 1 to 4.)

### 3.C Veo on Vertex / GEAP: the extra parameters

From https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/generate-videos-from-text:

```json
"parameters": {
  "aspectRatio": "ASPECT_RATIO",
  "negativePrompt": "NEGATIVE_PROMPT",
  "personGeneration": "PERSON_SAFETY_SETTING",
  // "resolution": RESOLUTION,   // Veo 3 models only
  "sampleCount": RESPONSE_COUNT,
  "seed": SEED_NUMBER,
  "storageUri": "OUTPUT_STORAGE_URI",
  "durationSeconds": 8
}
```

- `negativePrompt`: "A string value that describes content that you want to prevent the model from generating." **Vertex only.** Not on the Gemini API for either Veo or Omni.
- `personGeneration` on Vertex takes `"allow_adult"` and `"disallow"`, default `"allow_adult"`. This is a **different value set** from the Gemini API's `"allow_all"` / `"allow_adult"`. A client library must not share one enum across the two surfaces.
- `sampleCount`: 1 to 4. Gemini API is capped at 1.
- `seed`: uint32, 0 to 4294967295.
- `storageUri`: GCS output prefix; if omitted, base64 bytes come back inline.
- `durationSeconds` is an **integer** on Vertex, a **string** on the Gemini API.
- `resolution`: `"720p"`, `"1080p"`, `"4k"` with "(Veo 3.1 Preview models only)" on 4k.

`generateAudio`, `enhancePrompt` and `compressionQuality` were Veo 2 / early Veo 3 Vertex parameters and do **not** appear on the current Veo 3.1 Vertex pages I read. Treat them as removed; UNVERIFIED whether they are still silently accepted.

### 3.D Which knobs are uniform

Genuinely uniform across both Google video paths: **prompt, aspect ratio (16:9 / 9:16 only), resolution string, a first-frame image, a last-frame image, reference images, a video input for extend, MP4 out, 24 fps, audio always on.**

Not uniform, do not promote to a common request:

| Knob              | Omni                                                   | Veo 3.1 (Gemini API)                 | Veo 3.1 (Vertex)           |
| ----------------- | ------------------------------------------------------ | ------------------------------------ | -------------------------- |
| duration          | prompt-driven, 3 to 10s, undocumented `duration` field | `durationSeconds` string "4"/"6"/"8" | `durationSeconds` integer  |
| negative prompt   | not supported, use the prompt                          | not supported                        | `negativePrompt`           |
| seed              | no                                                     | ambiguous, UNVERIFIED                | yes, uint32                |
| person generation | no field                                               | `allow_all` / `allow_adult`          | `allow_adult` / `disallow` |
| number of videos  | no field                                               | 1                                    | `sampleCount` 1 to 4       |
| audio toggle      | none, always on                                        | none, always on                      | none, always on            |
| 4K                | yes, upscaled                                          | 3.1 and Fast only, 8s only           | Preview models only        |
| field naming      | `snake_case`                                           | `camelCase`                          | `camelCase`                |

The naming split is worth flagging: the Interactions API is `snake_case` end to end (`aspect_ratio`, `mime_type`, `previous_interaction_id`), while `predictLongRunning` is `camelCase` (`aspectRatio`, `mimeType`, `durationSeconds`). One provider package, two codecs.

---

## 4. Video-to-video, extend, editing

### Omni: all one endpoint

Everything is the same `POST /v1beta/interactions` call with different `input` parts, optionally disambiguated by `video_config.task`. There is no separate edit or extend endpoint.

- **Conversational edit of a generated video:** pass `previous_interaction_id` plus a text instruction ("Make the violin invisible."). No re-upload. "Each turn in the conversation produces a new video."
- **Edit an uploaded video:** Files API upload, then a `video` part plus a text instruction, `response_format: {"type": "video"}`.
- **Extend:** "The model analyzes the input video to generate a 3--10 second continuation." Either multi-turn (`previous_interaction_id`) or by passing an uploaded video `uri` plus "Continue the scene."
- **Extend with new elements:** add `image` parts alongside the video part, and refer to them in the prompt with tags like `<IMAGE_REF_0>`.
- **Interpolation:** two `image` parts, first and last frame.
- **Subject / ingredients to video:** multiple `image` parts, e.g. a cat and a ball of yarn, and a prompt combining them. Task id `reference_to_video`.
- **Camera controls:** prompt only. No camera parameter exists.

Extension constraints, verbatim:

> "**Spoken dialogue on uploaded videos**: Currently, you cannot extend an uploaded video where someone is talking to add additional dialogue (it is supported if the character remains silent or if the prompt does not add dialogue)."
> "**End-of-clip only**: Extension is limited to appending to the end of the video. You cannot prepend content or extend the middle of a clip."
> "**Duration limit**: Input videos for extension must be 10 seconds or less in length when uploading (unless using multi-turn)."
> "**Regional availability**: Extending uploaded videos is not currently available for users in the European Economic Area (EEA), Switzerland, and the United Kingdom (extending videos generated by the model is supported in all available regions)."

Also: "Referencing or reasoning across multiple videos is not supported." And "Voice editing is not supported."

Note the asymmetry: **extend caps the total at 10s per clip on uploads**, and the model card caps output at 3 to 10s, so Omni has no long-form path comparable to Veo's 148 seconds. The sibling landscape report's "up to 40 s total" figure is not supported by the current docs I read; treat it as UNVERIFIED / stale.

### Veo: same endpoint, extra instance fields

Extension, reference images and interpolation are all the same `:predictLongRunning` call with different `instances[0]` fields (`video`, `referenceImages`, `image` + `lastFrame`). No separate endpoint.

> "Use Veo 3.1 to extend videos that you previously generated with Veo by 7 seconds and up to 20 times."

Constraints: Veo-generated videos only ("Gemini API only supports video extensions for Veo-generated videos"), input up to 141 seconds, 9:16 or 16:9, 720p only, output "a single video combining the user input video and the generated extended video for up to 148 seconds of video". Not available on Veo 3.1 Lite. The input is passed as `{"video": {"inlineData": {"mimeType": "video/mp4", "data": "<base64>"}}}` in the REST sample, or as the SDK video object from a prior generation.

Reference images are `referenceType: "asset"` in every current sample, on both Gemini API and Vertex. A `"style"` reference type does not appear on any Veo 3.1 page I read (the Gemini API prose says "style and content references" but the only documented enum value is `asset`); **`referenceType: "style"` is UNVERIFIED for Veo 3.1.** Up to 3 reference images, Veo 3.1 and Fast only.

Vertex additionally documents an "Insert objects into Veo videos" page, so object insertion / editing exists on GEAP beyond what the Gemini API exposes (https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/insert-objects-into-videos). I did not read it in depth; its parameter set is UNVERIFIED here.

---

## 5. Audio

|                           | Omni                                                                                                                          | Veo 3.1 / Fast / Lite                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Native audio              | yes                                                                                                                           | yes                                                                                                               |
| Toggle                    | none                                                                                                                          | none. Model features table: "**Audio:** Natively generates audio with video. ✔️ Always on" for all three variants |
| Dialogue and lip-sync     | yes, prompted. Veo's own sample prompt embeds quoted dialogue in the prompt string                                            | yes, the flagship text-to-video sample is a "Dialogue & sound effects" example with quoted speech                 |
| Sound effects / music     | yes, prompted: "Include calm background music", "The video has a high energy techno beat"                                     | yes, "Prompting for audio" section                                                                                |
| Audio input               | accepted as an input modality by the model, but "Uploading audio references is unsupported in the current version of the API" | not supported (Vertex model card: Audio "Not supported")                                                          |
| Audio on video references | "any audio in a video reference is ignored"                                                                                   | n/a                                                                                                               |
| Container                 | `video/mp4`                                                                                                                   | `video/mp4`                                                                                                       |
| Codecs                    | **UNVERIFIED.** Neither page names a video or audio codec. Only `mimeType: video/mp4` and 24 FPS are documented.              | same                                                                                                              |

Veo has an audio-specific failure mode worth handling:

> "**Audio error:** Veo 3.1 will sometimes block a video from generating because of safety filters or other processing issues with the audio. You will not be charged if your video is blocked from generating."

Pricing page restates it: "In some cases, an audio processing issue may prevent a video from being generated. You will only be charged if your video is successfully generated."

Omni has an audio-editing gap: "Voice editing is not supported", and you cannot add dialogue when extending an uploaded video with a speaking subject.

---

## 6. Streaming and progressive delivery

**Short answer: no. Neither path gives you frames or segments before the whole video is done, and neither exposes a progress percentage.**

### Veo: plainly no

The Veo page's only statement about progress is the `done` boolean:

> "Video generation is a computationally intensive task. When you send a request to the API, it starts a long-running job and immediately returns an `operation` object. You must then poll until the video is ready, which is indicated by the `done` status being true."

Every sample polls `jq .done` on a 10 second loop. There is **no** `metadata.progressPercent`, no partial sample, no chunked delivery. Same on Vertex: `fetchPredictOperation` returns "information about the operation, including if the operation is still running or is done". Nothing finer than a boolean.

### Omni: SSE exists, but not for progressive video

This one needs care because there _is_ a streaming surface, and it _does_ touch video.

What is confirmed:

- The Interactions API supports `stream: true` with SSE, event types `interaction.created`, `interaction.status_update`, `step.start`, `step.delta`, `step.stop`, `interaction.completed`, `error` (https://ai.google.dev/gemini-api/docs/interactions/streaming).
- A `VideoDelta` type **exists** in the API reference (https://ai.google.dev/api/interactions), with fields `data`, `mime_type`, `resolution`, `uri`, `type: "video"`. So video can appear as a `step.delta` payload.
- The Omni guide implicitly confirms SSE carries video: "The `uri` field is only guaranteed to be present in the initial creation response or **Server-Sent Events (SSE) stream**."
- The Omni guide recommends turning streaming **off** for video: "Set `background=false`, `store=false`, and `stream=false` for faster, synchronous unary generation."

What is **not** confirmed, and should be treated as UNVERIFIED:

- The streaming guide's `step.start` table lists the expected delta types for a `model_output` step as **`text`, `image`, `audio`** and does not list `video`. The page has a "Streaming image generation" section and no video equivalent.
- Whether a video arrives as **multiple** `VideoDelta` chunks (progressively decodable) or as one delta at the end is nowhere stated. The image analogue streams in chunks (the sample prints `[Image chunk: N bytes]` per delta), which suggests video would chunk too, but a chunked base64 MP4 is a transport optimisation, not progressive playback: you still cannot render until the moov atom and enough of the mdat have arrived, and Google documents no fragmented-MP4 or HLS output.
- Background execution is documented as "supported for standard Gemini models (such as `gemini-3.8-flash` and `gemini-3.1-pro-preview`) and Managed Agents". Omni is not named. Its status values would be `in_progress`, `requires_action`, `completed`, `failed`, `cancelled`, with no percentage field.

**For a `VideoGenerator` capability:** model Google as request-then-await-a-whole-file. Model Veo as an explicit long-running operation with `done` polling at ~10s and a separate authenticated download. Model Omni as a single blocking call, optionally with a Files API poll when `delivery: "uri"`. Do not promise progressive frames on either. If we want a stream-shaped API, the only honest events are lifecycle events (submitted, still running, ready, downloading), not media.

The Omni URI mode is arguably worse than Veo's for a library, because the create call blocks for the full generation _and then_ you still have to poll the Files API for `ACTIVE`. Veo at least returns control immediately.

---

## 7. Output and safety

|                    | Omni                                                                                                                                                 | Veo 3.1                                                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Container          | MP4 (`video/mp4`)                                                                                                                                    | MP4 (`video/mp4`)                                                                                                        |
| Codec              | UNVERIFIED                                                                                                                                           | UNVERIFIED                                                                                                               |
| Frame rate         | 24 FPS                                                                                                                                               | 24 FPS                                                                                                                   |
| Duration           | 3s to 10s                                                                                                                                            | 4s, 6s, 8s (extension up to 148s total)                                                                                  |
| Resolutions        | 360p, 720p, 1080p (upscaled), 4K (upscaled)                                                                                                          | 720p, 1080p (8s only), 4k (8s only, not Lite)                                                                            |
| Videos per request | 1                                                                                                                                                    | 1 (Gemini API); up to 4 on Vertex via `sampleCount`                                                                      |
| Watermark          | "All generated videos include SynthID watermarking, which is invisible to viewers but can be detected programmatically for provenance verification." | "Videos created by Veo are watermarked using SynthID... Videos can be verified using the SynthID verification platform." |
| C2PA               | not stated on the Gemini API pages                                                                                                                   | "Content Credentials (C2PA): Supported" on GEAP for all three `-001` ids                                                 |
| Retention          | Files API 48 hours; interaction record 55 days paid / 1 day free                                                                                     | 2 days, timer resets if the video is referenced for extension                                                            |

**Safety filters.**

Omni: "Omni applies content safety filters to both input prompts and generated video (which vary by region). Prompts that violate usage policies are blocked." Plus the regional rules in Limitations: no uploading/editing images containing minors in the EEA, Switzerland and the UK; no uploading/editing images containing "certain recognizable people"; no editing or extending uploaded videos in the EEA, Switzerland and the UK.

Veo (Gemini API): "Generated videos are passed through safety filters and memorization checking processes that help mitigate privacy, copyright and bias risks." Regional: "In EU, UK, CH, MENA locations, `allow_adult` is the only allowed value for `personGeneration`."

**Finish / filter reasons.**

- `raiMediaFilteredCount` is a **Vertex / GEAP** field and appears in every done-operation sample there: `"response": {"raiMediaFilteredCount": 0, "@type": "type.googleapis.com/cloud.ai.large_models.vision.GenerateVideoResponse", "videos": [...]}`. A nonzero count with an empty `videos` array is how Vertex signals a fully filtered request.
- `raiMediaFilteredReasons` does **not** appear on any current Veo 3.1 page I read. It was present in older Imagen/Veo docs. **UNVERIFIED for Veo 3.1**, though it is plausible it still accompanies a nonzero count.
- On the **Gemini API**, no equivalent field is documented at all. The done operation shows only `response.generateVideoResponse.generatedSamples[]`. The documented failure behaviour is prose-level ("Veo 3.1 will sometimes block a video from generating... You will not be charged"). A client library has to treat an empty `generatedSamples` on a `done: true` operation as "filtered" without a machine-readable reason. **The absence of a reason code on the Gemini API is a real gap** and worth surfacing as a distinct error in our capability.
- Omni surfaces nothing structured either. A blocked prompt is an ordinary API error; the `error` SSE event shape is `{"error": {"message": "...", "code": "gateway_timeout"}, "event_type": "error"}`.

---

## 8. Pricing and limits

### Pricing (https://ai.google.dev/gemini-api/docs/pricing)

**Gemini Omni Flash** is billed as **tokens**, not seconds, which is unusual for a video model:

|                                    | Free tier     | Paid tier, per 1M tokens USD         |
| ---------------------------------- | ------------- | ------------------------------------ |
| Input                              | Not available | $1.50 (text / image / video / audio) |
| Output (including thinking tokens) | Not available | $9.00 (text), $17.50 (video)         |

Footnote, verbatim:

> "Billing is based on total output token consumption, calculated at a rate of 5,792 tokens per second of 720p video. Under Standard pricing, this equates to an effective price of approximately $0.10 per second."

Two consequences for a client library: (a) there is **no free tier** for Omni at all; (b) cost is not knowable from duration alone at other resolutions, because the docs only give the tokens-per-second rate for 720p. The token cost of 1080p and 4K (which are upscales) is **UNVERIFIED**. A 10 second 720p clip is roughly 57,920 output tokens, about $1.01.

**Veo 3.1**, billed per second of output video, audio included in the price:

| Model                                        | Free tier     | Paid tier, per second USD                     |
| -------------------------------------------- | ------------- | --------------------------------------------- |
| Veo 3.1 Standard, video with audio (default) | Not available | $0.40 (720p and 1080p), $0.60 (4k)            |
| Veo 3.1 Fast, video with audio (default)     | Not available | $0.10 (720p), $0.12 (1080p), $0.30 (4k)       |
| Veo 3.1 Lite, video with audio (default)     | Not available | $0.05 (720p), $0.08 (1080p), 4k not supported |

There is no audio-off price row any more (Veo 3.0 used to have one); audio is always on and always priced in. No free tier on any Veo model.

Per 8 second clip at 720p: Standard $3.20, Fast $0.80, Lite $0.40, Omni ~$0.80. So **Omni sits at Veo 3.1 Fast pricing and is 4x cheaper than Veo 3.1 Standard**, which explains the default-model recommendation.

### Latency

Veo, verbatim: "**Request latency:** Min: 11 seconds; Max: 6 minutes (during peak hours)."

Omni: no number published. "Video generation times vary based on duration, resolution, and current API load. Longer and higher-resolution videos take more time to generate." Given the recommended synchronous unary mode, a client library must allow a **multi-minute HTTP timeout** on the Omni create call, which is the single most important practical detail on that path. UNVERIFIED what Google's own request deadline is; the documented SSE `error` example uses `"code": "gateway_timeout"` with "Deadline expired before operation could complete.", which suggests long unary calls do time out at the gateway.

### Rate limits and quotas

**Gemini API:** per-model rate limits for video models are **not published in the docs**. https://ai.google.dev/gemini-api/docs/rate-limits explains the RPM / TPM / RPD dimensions and the usage tiers but publishes no rows for `gemini-omni-1.1-flash` or any `veo-*` id, and the Veo page links to https://aistudio.google.com/rate-limit (login required) for "more Veo model-specific usage details". So exact RPM / RPD for video are **UNVERIFIED**. What is documented and relevant:

- Limits are per project, not per API key. RPD resets at midnight Pacific.
- "Rate limits are more restricted for experimental and preview models." All three Veo 3.1 ids are Preview.
- Spend-based limits on a rolling 10 minute window: Free N/A, Tier 1 $10, Tier 2 $50, Tier 3 $200, returning `429 RESOURCE_EXHAUSTED`. **This matters a lot for video**: at Veo 3.1 Standard 720p ($0.40/s), a Tier 1 project hits the $10 / 10 min ceiling after roughly three 8 second clips. A `VideoGenerator` on Google must treat 429 as routine and back off, not as a bug.
- There is **no documented concurrent-operations limit** on the Gemini API. UNVERIFIED whether one exists.
- Provisioned throughput is explicitly **not supported** for Omni.

**GEAP / Vertex:** published and concrete, from the Veo 3.1 model page: "Regional online prediction requests per base model per minute per base model: 50 tokens per minute", for each of the three `-001` ids. (The unit string is Google's, and is confusingly worded; read it as 50 requests per minute per base model per region.) Consumption options for Veo 3.1 on GEAP: Provisioned Throughput supported, **Pay-as-you-go not supported**, Batch inference not supported, Fixed quota supported. Region: us-central1 only.

---

## 9. Minimal JSON examples

### 9.A Omni, create (synchronous, inline bytes)

Request:

```http
POST https://generativelanguage.googleapis.com/v1beta/interactions
x-goog-api-key: $GEMINI_API_KEY
Content-Type: application/json
```

```json
{
  "model": "gemini-omni-1.1-flash",
  "input": "A marble rolling fast on a chain reaction style track, continuous smooth shot.",
  "response_format": { "type": "video", "aspect_ratio": "16:9", "resolution": "720p" }
}
```

Response (this _is_ the done response; there is no pending state in unary mode):

```json
{
  "steps": [
    { "type": "user_input", "content": [{ "type": "text", "text": "..." }] },
    { "type": "thought", "content": [{ "text": "...", "type": "thought" }] },
    {
      "type": "model_output",
      "content": [{ "type": "video", "mime_type": "video/mp4", "data": "AAAAIGZ0eXBpc29t..." }]
    }
  ],
  "id": "v1_...",
  "status": "completed",
  "model": "gemini-omni-1.1-flash",
  "object": "interaction"
}
```

### 9.B Omni, URI delivery (the closest thing to a pending poll)

Create:

```json
{
  "model": "gemini-omni-1.1-flash",
  "input": "A beautiful sunset over a calm ocean.",
  "response_format": { "type": "video", "delivery": "uri" }
}
```

Create response carries the URI:

```json
{
  "steps": [
    {
      "type": "model_output",
      "content": [
        {
          "type": "video",
          "mime_type": "video/mp4",
          "uri": "https://generativelanguage.googleapis.com/v1beta/files/abc-123:download?alt=media"
        }
      ]
    }
  ],
  "id": "v1_...",
  "status": "completed"
}
```

Pending poll, `GET /v1beta/files/abc-123`:

```json
{ "name": "files/abc-123", "state": "PROCESSING" }
```

Done poll:

```json
{ "name": "files/abc-123", "state": "ACTIVE", "mimeType": "video/mp4" }
```

Then `GET /v1beta/files/abc-123:download?alt=media` with the API key returns the MP4 bytes. The sample loop sleeps 5 seconds between polls.

### 9.C Veo, create

```http
POST https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning
x-goog-api-key: $GEMINI_API_KEY
Content-Type: application/json
```

```json
{
  "instances": [{ "prompt": "A cinematic shot of a majestic lion in the savannah." }],
  "parameters": {
    "aspectRatio": "16:9",
    "resolution": "720p",
    "durationSeconds": "8",
    "personGeneration": "allow_all"
  }
}
```

Response:

```json
{ "name": "models/veo-3.1-generate-preview/operations/abc123xyz" }
```

### 9.D Veo, pending poll

`GET https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview/operations/abc123xyz` with the API key header:

```json
{
  "name": "models/veo-3.1-generate-preview/operations/abc123xyz",
  "metadata": {
    "@type": "type.googleapis.com/google.ai.generativelanguage.v1beta.GenerateVideoMetadata"
  }
}
```

`done` is simply absent (or `false`) while running. The samples test `jq .done`. The `metadata` shape above is reconstructed from the operation convention and is **UNVERIFIED**: the Gemini docs never print a pending poll body, only `is_done=$(echo "${status_response}" | jq .done)`. **There is no progress field.**

### 9.E Veo, done poll

```json
{
  "name": "models/veo-3.1-generate-preview/operations/abc123xyz",
  "done": true,
  "response": {
    "generateVideoResponse": {
      "generatedSamples": [
        {
          "video": {
            "uri": "https://generativelanguage.googleapis.com/v1beta/files/xyz789:download?alt=media"
          }
        }
      ]
    }
  }
}
```

Field path confirmed by the official jq: `.response.generateVideoResponse.generatedSamples[0].video.uri`. The wrapper key names (`name`, `done`, `response`) are the standard LRO envelope. Download with `curl -L -H "x-goog-api-key: $GEMINI_API_KEY" "$video_uri"`.

### 9.F Veo extension, create

```json
{
  "instances": [
    {
      "prompt": "Track the butterfly into the garden as it lands on an orange origami flower. A fluffy white puppy runs up and gently pats the flower.",
      "video": {
        "inlineData": { "mimeType": "video/mp4", "data": "<base64 of a previous Veo generation>" }
      }
    }
  ],
  "parameters": { "numberOfVideos": 1, "resolution": "720p" }
}
```

### 9.G Veo reference images, create

```json
{
  "instances": [
    {
      "prompt": "...",
      "referenceImages": [
        {
          "image": { "inlineData": { "mimeType": "image/png", "data": "<b64>" } },
          "referenceType": "asset"
        },
        {
          "image": { "inlineData": { "mimeType": "image/png", "data": "<b64>" } },
          "referenceType": "asset"
        },
        {
          "image": { "inlineData": { "mimeType": "image/png", "data": "<b64>" } },
          "referenceType": "asset"
        }
      ]
    }
  ]
}
```

### 9.H Vertex / GEAP, done poll (for contrast)

```json
{
  "name": "projects/PROJECT_ID/locations/us-central1/publishers/google/models/MODEL_ID/operations/OPERATION_ID",
  "done": true,
  "response": {
    "raiMediaFilteredCount": 0,
    "@type": "type.googleapis.com/cloud.ai.large_models.vision.GenerateVideoResponse",
    "videos": [
      { "gcsUri": "gs://BUCKET_NAME/TIMESTAMPED_FOLDER/sample_0.mp4", "mimeType": "video/mp4" }
    ]
  }
}
```

Note the response key is `videos` with `gcsUri`, not `generateVideoResponse.generatedSamples[].video.uri`. **The two surfaces have incompatible done-response shapes** even though both are `predictLongRunning`. Without `storageUri`, the same slot carries `bytesBase64Encoded` instead of `gcsUri`.

---

## Notes for the VideoGenerator design

1. Two codecs, one provider package. Omni is `snake_case` Interactions API; Veo is `camelCase` predict/LRO; Vertex Veo is a third shape again (`sampleCount`, `storageUri`, `gcsUri`, POST-based polling, OAuth). Do not try to unify the operation model.
2. The capability's core shape should be "submit, await, fetch bytes". Progressive delivery does not exist on Google. Lifecycle events are the only honest stream.
3. Omni's synchronous create needs a long HTTP timeout, and `delivery: "uri"` does not make it asynchronous, it adds a second wait.
4. Capture the file URI from the Omni create response. Re-reading the interaction loses it.
5. `personGeneration` values differ between Gemini API and Vertex. `durationSeconds` is a string on one and an integer on the other. Two provider-typed request records, not one.
6. Retention is short and differs per path: 48 hours (Omni Files API) vs 2 days (Veo). Downloading eagerly is the right default.
7. Spend-based 429s are expected at Tier 1 volumes for Veo Standard. Retry with backoff belongs in the recipe.
8. Neither path gives a machine-readable safety reason on the Gemini API. Vertex gives `raiMediaFilteredCount`. Expect "done, zero samples" as a real outcome.

---

## Sources

- https://ai.google.dev/gemini-api/docs/video
- https://ai.google.dev/gemini-api/docs/omni
- https://ai.google.dev/gemini-api/docs/veo
- https://ai.google.dev/gemini-api/docs/models
- https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash
- https://ai.google.dev/gemini-api/docs/pricing
- https://ai.google.dev/gemini-api/docs/rate-limits
- https://ai.google.dev/gemini-api/docs/changelog
- https://ai.google.dev/gemini-api/docs/deprecations
- https://ai.google.dev/gemini-api/docs/files
- https://ai.google.dev/gemini-api/docs/interactions-overview
- https://ai.google.dev/gemini-api/docs/interactions
- https://ai.google.dev/gemini-api/docs/interactions/streaming
- https://ai.google.dev/gemini-api/docs/background-execution
- https://ai.google.dev/api/interactions
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/veo/3-1-generate
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/veo-video-generation
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/generate-videos-from-text
- https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/use-reference-images-to-guide-video-generation
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/extend-videos
- https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/video/insert-objects-into-videos
