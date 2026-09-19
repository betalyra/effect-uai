# Subagent report: video generation, MiniMax Hailuo and ByteDance Seedance (2026-09-19)

Raw research report; summarised in `../video-generation.md`.

Conventions: model ids are quoted exactly as the vendor prints them. Anything I could not confirm from a vendor-owned page (platform.minimax.io, minimax.io, docs.byteplus.com, byteplus.com, seed.bytedance.com, the official `volcengine-python-sdk` repo) is tagged UNVERIFIED with the secondary source named. docs.byteplus.com API pages are client-rendered and my fetcher only saw the navigation shell, so the ModelArk request/response shape below is reconstructed from the official Volcengine Ark Python SDK source, the BytePlus engineering blog, and ComfyUI's BytePlus router mirror; each field says where it came from.

---

## Part 1: MiniMax (platform.minimax.io)

### 1.1 Naming: what "Hailuo 3 Max" actually is

There is no product called "Hailuo 3 Max". What exists today:

| Marketing name                           | API model id                                | Released                                                   | Status on MiniMax platform                                           |
| ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| MiniMax H3 (press calls it "Hailuo 3.0") | `MiniMax-H3`                                | Jul 31, 2026                                               | Active, "Video Generation V2" API                                    |
| MiniMax H3 Max                           | `MiniMax-H3-Max`                            | Aug 2026 (listed in V2 create docs; no dated release note) | Active, V2 API; fal.ai post-trained variant that MiniMax also serves |
| Hailuo 2.3                               | `MiniMax-Hailuo-2.3`                        | Oct 28, 2025                                               | "Legacy Models" (V1 API)                                             |
| Hailuo 2.3 Fast                          | `MiniMax-Hailuo-2.3-Fast`                   | Oct 28, 2025                                               | Legacy (V1, image-to-video only)                                     |
| Hailuo 02                                | `MiniMax-Hailuo-02`                         | Jun 18, 2025                                               | Legacy (V1)                                                          |
| 01 Director                              | `T2V-01-Director`, `I2V-01-Director`        | Feb 11, 2025                                               | Still listed in V1 request docs, not on pricing page                 |
| 01                                       | `T2V-01`, `I2V-01`, `I2V-01-live`, `S2V-01` | 2024 to Jan 2025                                           | Still listed in V1 request docs, not on pricing page                 |

Sources: models overview https://platform.minimax.io/docs/guides/models-intro.md (H3 and H3 Max "Active", Hailuo 2.3 / 2.3Fast / 02 "Legacy"); release notes https://platform.minimax.io/docs/release-notes/models.md (H3 Jul 31 2026, Hailuo 2.3 Oct 28 2025, Hailuo 02 Jun 18 2025, Director Feb 11 2025); V2 create reference https://platform.minimax.io/docs/api-reference/video-generation-v2-create ("Currently available: `MiniMax-H3`, `MiniMax-H3-Max`"); MiniMax H3 launch blog https://www.minimax.io/blog/minimax-h3; fal's H3 Max announcement https://blog.fal.ai/introducing-h3-max-by-fal/.

H3 Max provenance: MiniMax's own guide says H3 Max is "co-developed by MiniMax and fal.ai" and "post-trained by fal.ai on MiniMax H3", optimised for speed (https://platform.minimax.io/docs/guides/video-generation). fal's blog says it started from the open MiniMax H3 weights, added post-training data for prompt adherence and aesthetics, and runs on fal's inference stack. So the user's "Hailuo 3 Max" is `MiniMax-H3-Max`.

H3 open weights: MiniMax says weights were opened Aug 3, 2026 (https://www.minimax.io/news/minimax-h3-open-source, https://github.com/MiniMax-AI/MiniMax-H3, https://huggingface.co/MiniMaxAI/MiniMax-H3). Not relevant to the API design but explains the fal derivative.

### 1.2 Trade-offs per current model

| Model                     | Resolution              | Duration                             | Inputs                                                                | Audio                                                    | Speed                                                                      | Price (output)                                                |
| ------------------------- | ----------------------- | ------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `MiniMax-H3`              | `768P`, `2K`            | 4 to 15 s (integer)                  | text, first/last frame, up to 9 ref images, 3 ref videos, 3 ref audio | Native stereo audio always generated                     | fal measured 53.2 s for a 5 s 768P clip on the official endpoint           | $0.08/s at 768P, $0.13/s at 2K                                |
| `MiniMax-H3-Max`          | `480P`, `768P`          | 5 to 15 s                            | text, first/last frame, references (fewer free images)                | Same model family; fal schema exposes `target_audio_url` | fal claims 2.78 s for a 5 s 768P clip (about 35x the official H3 endpoint) | $0.05/s at 480P, $0.08/s at 768P                              |
| `MiniMax-Hailuo-2.3`      | `768P`, `1080P`         | 6 s (768P/1080P) or 10 s (768P only) | text or first frame                                                   | None                                                     | n/a                                                                        | $0.28 (768P 6s), $0.56 (768P 10s), $0.49 (1080P 6s) per video |
| `MiniMax-Hailuo-2.3-Fast` | `768P`, `1080P`         | 6 or 10 s                            | first frame only                                                      | None                                                     | "30 to 50% faster" (MiniMax news)                                          | $0.19 / $0.32 / $0.33 per video                               |
| `MiniMax-Hailuo-02`       | `512P`, `768P`, `1080P` | 6 or 10 s                            | text, first frame, first+last frame                                   | None                                                     | n/a                                                                        | $0.10 (512P 6s), $0.15 (512P 10s), $0.28, $0.56, $0.49        |

Sources: https://platform.minimax.io/docs/guides/pricing-paygo.md (all prices), https://platform.minimax.io/docs/guides/video-generation.md (H3/H3 Max specs), https://blog.fal.ai/introducing-h3-max-by-fal/ (latency), https://www.minimax.io/news/minimax-hailuo-23 (Fast speed claim).

Additional V2 charges (pricing-paygo): H3 reference audio free; reference images first 5 free then $0.04 each; reference video billed by input duration at the output-resolution rate. H3-Max: first 2 images free then $0.074 each; reference video $0.0553/s at 480P, $0.143/s at 768P. `MiniMax-H3-Regeneration` (768P to 2K upscale) $0.05/s. `H3-Context-IR` $0.90/M input tokens, $3.60/M output tokens.

### 1.3 Endpoints and auth

Base URLs: international `https://api.minimax.io`, mainland China `https://api.minimaxi.com` (MiniMax's official MCP README: "The API key needs to match the host", https://github.com/MiniMax-AI/MiniMax-MCP). Auth on every endpoint: `Authorization: Bearer <api key>`.

Two generations of API coexist:

| Purpose | V2 (H3, H3 Max)                                                                                                           | V1 (Hailuo, 01 series)                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Create  | `POST /v2/video_generation`                                                                                               | `POST /v1/video_generation`                                                             |
| Poll    | `GET /v2/query/video_generation/{task_id}`                                                                                | `GET /v1/query/video_generation?task_id=`                                               |
| List    | `GET /v2/query/video_generation?page_num=&page_size=&filter.status=&filter.model=&filter.task_type=&filter.task_ids=`     | none                                                                                    |
| Result  | `task.content.url` in the poll response (time-limited)                                                                    | `file_id` from poll, then `GET /v1/files/retrieve?file_id=` returns `file.download_url` |
| Cancel  | `DELETE /v2/video_generation/{task_id}` (cancels `queued`, deletes `succeeded`/`failed`, errors on `running`/`cancelled`) | none                                                                                    |
| Webhook | `callback_url` in create body                                                                                             | `callback_url` in create body                                                           |
| Extras  | `POST /v2/h3_context_ir` (prompt enhancer, returns text), `POST /v2/video_regeneration` (768P to 2K)                      | first-and-last-frame and subject-reference variants share `/v1/video_generation`        |

Sources: https://platform.minimax.io/docs/api-reference/video-generation-v2-create, .../video-generation-v2-query, .../video-generation-v2-list.md, .../video-generation-v2-delete.md, .../video-generation-v2-h3-context-ir, .../video-generation-v2-regeneration, .../video-generation-t2v, .../video-generation-i2v, .../video-generation-fl2v.md, .../video-generation-s2v, .../video-generation-query, .../file-management-retrieve, .../video-generation-download.

Callback contract (both generations): on create, MiniMax first POSTs `{ "challenge": "..." }` to `callback_url`; the server must echo the `challenge` value unchanged within 3 seconds, otherwise the callback is not registered. After that MiniMax POSTs status changes. V1 callback payload example from the t2v reference:

```json
{
  "task_id": "115334141465231360",
  "status": "success",
  "file_id": "205258526306433",
  "base_resp": { "status_code": 0, "status_msg": "success" }
}
```

V1 callback statuses are lowercase `processing`, `success`, `failed` while V1 polling statuses are capitalised (see 1.5). Retry policy is not documented. V2 callback payload shape is not shown in the docs; assume the task object (UNVERIFIED).

### 1.4 Request parameters

V2 (`MiniMax-H3`, `MiniMax-H3-Max`), from video-generation-v2-create:

| Param          | Type    | Required | Values / notes                                                                                                                                                                                     |
| -------------- | ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`        | string  | yes      | `MiniMax-H3`, `MiniMax-H3-Max`                                                                                                                                                                     |
| `content`      | array   | yes      | Multimodal items, at least one non-empty `text` item. Prompt max 7000 chars.                                                                                                                       |
| `resolution`   | string  | yes      | H3: `768P`, `2K`. H3-Max: `480P`, `768P`.                                                                                                                                                          |
| `duration`     | integer | yes      | H3 4 to 15, H3-Max 5 to 15                                                                                                                                                                         |
| `ratio`        | string  | no       | `adaptive` (default), `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`. Text-to-video: required and must not be `adaptive`. Image-to-video: forced `adaptive`. Reference-to-video: defaults `adaptive`. |
| `extra`        | object  | no       | H3-Max only: `prompt_expansion_mode`: `disabled`, `balanced` (default), `quality`                                                                                                                  |
| `callback_url` | string  | no       | see 1.3                                                                                                                                                                                            |

Content item: `{ "type": "text" | "image_url" | "video_url" | "audio_url", "text"?, "image_url"?: {"url"}, "video_url"?: {"url"}, "audio_url"?: {"url"}, "role"?: "first_frame" | "last_frame" | "reference_image" | "reference_video" | "reference_audio" }`. URL may be public https, `mm_file://{file_id}` (uploaded via `/v1/files/upload`), or a `data:` base64 URI (docs say prefer URLs for large files). Limits: images JPG/PNG/WEBP/HEIC/HEIF, 30 MB, 256 to 5760 px, w/h 0.4 to 2.5, at most 1 first frame + 1 last frame + 9 reference images; videos MP4/MOV (H.264/H.265, AAC/MP3), 50 MB, at most 3 clips, 2 to 15 s each and 15 s total, 23.976 to 60 fps; audio WAV/MP3, 15 MB, at most 3 clips, 2 to 15 s each, 15 s total; whole body 64 MB. First/last frame roles and reference roles are mutually exclusive in one request.

Not present in V2: `seed`, `fps`, `watermark`, `prompt_optimizer`, an audio on/off toggle, number of outputs. Output is always 24 fps (models-intro). Audio is always generated ("all audio output is native stereo", H3 blog); there is no knob to disable it. `aigc_watermark` (boolean, default false) exists only on `POST /v2/video_regeneration`.

V1 (Hailuo and 01 models), from the t2v / i2v / fl2v / s2v references:

| Param               | Type    | Notes                                                                                                                                                                                                                                                                             |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`             | string  | t2v: `MiniMax-Hailuo-2.3`, `MiniMax-Hailuo-02`, `T2V-01-Director`, `T2V-01`. i2v: `MiniMax-Hailuo-2.3`, `MiniMax-Hailuo-2.3-Fast`, `MiniMax-Hailuo-02`, `I2V-01-Director`, `I2V-01-live`, `I2V-01`. First+last frame: `MiniMax-Hailuo-02` only. Subject reference: `S2V-01` only. |
| `prompt`            | string  | max 2000 chars; camera commands in brackets: `[Truck left]`, `[Truck right]`, `[Pan left]`, `[Pan right]`, `[Push in]`, `[Pull out]`, `[Pedestal up]`, `[Pedestal down]`, `[Tilt up]`, `[Tilt down]`, `[Zoom in]`, `[Zoom out]`, `[Shake]`, `[Tracking shot]`, `[Static shot]`    |
| `prompt_optimizer`  | boolean | default true                                                                                                                                                                                                                                                                      |
| `fast_pretreatment` | boolean | default false, Hailuo models only, shortens prompt-optimisation time                                                                                                                                                                                                              |
| `duration`          | integer | 6 or 10 (10 only at 768P and 512P); 01 models fixed 6                                                                                                                                                                                                                             |
| `resolution`        | string  | `512P` (Hailuo-02 only), `768P` (default), `1080P` (6 s only); 01 models `720P`                                                                                                                                                                                                   |
| `first_frame_image` | string  | i2v: required. URL or `data:image/...;base64,`; JPG/JPEG/PNG/WebP, under 20 MB, short edge over 300 px, aspect 2:5 to 5:2                                                                                                                                                         |
| `last_frame_image`  | string  | first-and-last-frame endpoint (Hailuo-02, not 512P); last frame is cropped to the first frame's size if they differ                                                                                                                                                               |
| `subject_reference` | array   | `S2V-01` only: `[{ "type": "character", "image": ["<one url>"] }]`, single face image                                                                                                                                                                                             |
| `callback_url`      | string  | see 1.3                                                                                                                                                                                                                                                                           |

V1 has no aspect ratio param (t2v is 16:9; i2v follows the image), no seed, no audio, no watermark toggle.

### 1.5 Task lifecycle

V2 statuses: `queued`, `running`, `succeeded`, `failed`, `cancelled`. No progress percentage. Only tasks from the last 7 days can be queried or listed. `content.url` is "time-limited, so download or store promptly"; the exact TTL is not printed on the V2 pages. Failed tasks carry `error: { code, message }` (example code `"1026"` for sensitive prompt). HTTP-level errors use an OpenAI-style envelope: 400 `bad_request_error`, 401 `authorized_error`, 402 `insufficient_balance_error`, 422 `unprocessable_entity_error` (sensitive content), 429 `rate_limit_error`, 500 `server_error`, body `{ "type": "error", "error": { "type", "message", "http_code" }, "request_id" }`.

V1 statuses: `Preparing`, `Queueing`, `Processing`, `Success`, `Fail` (capitalised). Success adds `file_id`, `video_width`, `video_height`. `base_resp.status_code`: 0 ok, 1002 rate limit, 1004 auth failed, 1008 insufficient balance, 1026 prompt sensitive, 1027 generated video sensitive, 2013 invalid params, 2049 invalid API key. `download_url` from `/v1/files/retrieve` is "valid for 1 hour" (video-generation-download page). Recommended poll interval: 10 s (video-generation guide).

### 1.6 Streaming or progressive delivery

None. Both MiniMax APIs are submit, poll, download. No partial frames, no chunked segments, no SSE for video. The only "streaming" in MiniMax's catalogue is text and speech. Their "Video Agent" API (`/docs/api-reference/video-agent-create`) is template-based batch generation, not live. Third-party posts about "real-time H3" refer to self-hosted inference throughput (vLLM-Omni / FastVideo rendering a 10 s clip in about 9 s), not an API stream.

### 1.7 Output

MP4. V2 accepts and, per the regeneration input spec, produces H.264 at 24 fps with an audio track (the regeneration source must be "24 fps, dimensions divisible by 32, audio track required", which describes H3's own 768P output). V1 downloads are named `output_aigc.mp4`. Watermark: no toggle on V1 or V2 create; V1 output has historically been unwatermarked on the API, and V2 regeneration has `aigc_watermark` defaulting to false. Retention: V2 tasks queryable for 7 days; V1 download URL 1 hour after retrieval (file itself persists in the Files API until deleted). `2K` on `MiniMax-H3` is native output; fal additionally offers `4K` for H3 but labels 2K/4K on its endpoint as upscales from a 768P base (fal schema), which does not match MiniMax's own "native 2K" claim; treat resolution semantics on aggregators as aggregator-specific.

### 1.8 Rate limits

https://platform.minimax.io/docs/guides/rate-limits: Hailuo series 20 RPM; `MiniMax-H3` 300 RPM and 30 concurrent in-flight tasks. Prepaid "video packages" ($1,000 to $6,000 per month) raise Hailuo RPM to 20 to 50 and do not cover H3 ("MiniMax H3 is not supported yet", https://platform.minimax.io/docs/guides/pricing-video). Failed generations are not charged.

### 1.9 Minimal JSON

V2 submit (text to video):

```json
POST https://api.minimax.io/v2/video_generation
{ "model": "MiniMax-H3",
  "content": [ { "type": "text", "text": "A boy playing basketball by the sea" } ],
  "resolution": "2K", "duration": 5, "ratio": "16:9" }
```

V2 submit (first frame + reference audio, H3 Max):

```json
{
  "model": "MiniMax-H3-Max",
  "content": [
    { "type": "text", "text": "She turns to camera and says the line" },
    {
      "type": "image_url",
      "image_url": { "url": "https://example.com/a.png" },
      "role": "first_frame"
    }
  ],
  "resolution": "768P",
  "duration": 6,
  "extra": { "prompt_expansion_mode": "balanced" }
}
```

V2 create response: `{ "task_id": "424010985738629" }`

V2 poll, pending: `{ "task": { "id": "424010985738629", "status": "queued", "created_at": 1785125529, "updated_at": 1785125600 } }`

V2 poll, done:

```json
{
  "task": {
    "id": "424010985738629",
    "model": "MiniMax-H3",
    "status": "succeeded",
    "created_at": 1785125529,
    "updated_at": 1785125946,
    "content": { "url": "https://cdn.example.com/output.mp4" },
    "resolution": "2K",
    "duration": 5,
    "ratio": "16:9",
    "task_type": "generation",
    "modality": "video",
    "usage": { "total_seconds": 5, "input_seconds": 0, "output_seconds": 5, "input_image_count": 0 }
  }
}
```

V1 submit: `{ "model": "MiniMax-Hailuo-2.3", "prompt": "A mouse runs toward the camera [Push in]", "first_frame_image": "https://...jpeg", "duration": 6, "resolution": "1080P" }` returns `{ "task_id": "106916112212032", "base_resp": { "status_code": 0, "status_msg": "success" } }`; poll returns `{ "task_id": "...", "status": "Success", "file_id": "176844028768320", "video_width": 1920, "video_height": 1080, "base_resp": {...} }`; then `GET /v1/files/retrieve?file_id=176844028768320` returns `{ "file": { "file_id": 176844028768320, "bytes": 5896337, "filename": "output_aigc.mp4", "purpose": "video_generation", "download_url": "https://..." }, "base_resp": {...} }`.

### 1.10 Aggregators

| Aggregator | Endpoints                                                                                                                                                                                                                                      | Knob parity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fal.ai     | `minimax/h3/text-to-video`, `minimax/h3/image-to-video`, `minimax/h3/reference-to-video`; `minimax/h3-max/text-to-video`, `minimax/h3-max/image-to-video`; `fal-ai/minimax/hailuo-2.3-fast/{standard,pro}/image-to-video`, hailuo-02, video-01 | Flat fields instead of `content[]`: `prompt`, `image_url`, `end_image_url`, `reference_image_urls` (9), `reference_video_urls`, `reference_audio_urls` (12 files total), `duration`, `resolution` (`480P`, `768P`, `2K`, `4K` on H3; `480P`, `768P`, `1080P` on H3 Max), `aspect_ratio`, `seed`, `prompt_expansion_mode` (adds `fast`), `target_audio_url`, `sync_mode`, `enable_safety_checker`. Extra knobs (`seed`, `4K`, `1080P` H3 Max, `target_audio_url`) do not exist on MiniMax's own API. H3 Max fal price: $0.05/s 480P, $0.08/s 768P, $0.16/s 1080P (50% off until Sep 30, 2026). Hailuo on fal splits "standard" (768P) vs "pro" (1080P) as separate endpoints. |
| Replicate  | `minimax/h3`, `minimax/hailuo-2.3`, `minimax/hailuo-2.3-fast`, `minimax/hailuo-02`, `minimax/hailuo-02-fast`, `minimax/video-01-director`, `minimax/video-01-live`, `minimax/video-01`                                                         | `minimax/h3` mirrors V2 closely: `prompt`, `first_frame_image`, `last_frame_image`, `reference_image_urls`, `reference_video_urls`, `reference_audio_urls`, `duration` 4 to 15, `resolution` `768P`/`2K`, `ratio`; same $0.08/$0.13 per second. No `MiniMax-H3-Max` on Replicate as of today.                                                                                                                                                                                                                                                                                                                                                                                |

Sources: https://fal.ai/models/minimax/h3/text-to-video/api, https://fal.ai/models/minimax/h3/reference-to-video/api, https://fal.ai/models/minimax/h3-max/text-to-video, https://fal.ai/models/minimax/h3-max/image-to-video/api, https://fal.ai/models/fal-ai/minimax/hailuo-2.3-fast/pro/image-to-video/api, https://replicate.com/minimax, https://replicate.com/minimax/h3, https://replicate.com/minimax/hailuo-2.3.

---

## Part 2: ByteDance Seedance (BytePlus ModelArk international, Volcengine Ark China)

### 2.1 Model ids

The Seedance API sits on the generic ModelArk "content generation task" API; the model id selects the version. Exact ids (from ComfyUI's BytePlus router which mirrors ModelArk ids, cross-checked against BytePlus doc pages where those rendered):

| Marketing name             | ModelArk id                                                    | Released                                                                             | Duration               | Resolution                                                                                                         | Notes                                                                                                                    |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Dreamina Seedance 2.5      | `dreamina-seedance-2-5-260628`                                 | Jul 31, 2026 (Dreamina); API "fully available" per BytePlus product page in Aug 2026 | 4 to 30 s or `-1` auto | `480p`, `720p` on the BytePlus rate card; `1080p` and `4k` appear in the router schema (UNVERIFIED for direct API) | Current flagship. Up to 50 reference assets (30 images, 10 videos, 10 audio), editing and extension tasks, native audio. |
| Dreamina Seedance 2.0      | `dreamina-seedance-2-0-260128`                                 | Announced Feb 12, 2026; BytePlus API GA Apr 14, 2026                                 | 4 to 15 s or `-1`      | `480p`, `720p` (schema note: "2.0 doesn't support 1080p")                                                          | Multimodal references, editing, extension, native audio.                                                                 |
| Dreamina Seedance 2.0 Fast | `dreamina-seedance-2-0-fast-260128`                            | Apr 2026                                                                             | 4 to 15 s              | `480p`, `720p`                                                                                                     | Speed tier.                                                                                                              |
| Dreamina Seedance 2.0 mini | `dreamina-seedance-2-0-mini`                                   | listed by BytePlus activity page alongside 2.0                                       | 4 to 15 s              | `480p`, `720p`                                                                                                     | Cheaper, faster, has `camera_fixed`.                                                                                     |
| Seedance 1.5 Pro           | `seedance-1-5-pro-251215`                                      | Dec 2025                                                                             | 4 to 12 s              | `480p`, `720p`, `1080p`                                                                                            | First Seedance with joint audio-video generation and lip sync.                                                           |
| Seedance 1.0 Pro           | `seedance-1-0-pro-250528`                                      | May 28, 2025                                                                         | 2 to 12 s              | `480p`, `720p`, `1080p`, `4k` (router default 1080p)                                                               | t2v, i2v, first+last frame. $2.50 per M tokens.                                                                          |
| Seedance 1.0 Pro Fast      | `seedance-1-0-pro-fast-251015`                                 | Oct 15, 2025                                                                         | same                   | same                                                                                                               | Speed tier of 1.0 Pro.                                                                                                   |
| Seedance 1.0 Lite          | `seedance-1-0-lite-t2v-250428`, `seedance-1-0-lite-i2v-250428` | Apr 28, 2025                                                                         | 5 or 10 s              | `480p`, `720p`, `1080p`                                                                                            | Legacy; parameters were embedded in the prompt as `--ratio 16:9 --duration 5` text commands.                             |

Sources: https://docs.comfy.org/development/comfy-router/models/byteplus (id list), https://docs.byteplus.com/en/docs/ModelArk/1587798 (`seedance-1-0-pro-250528`, $2.5/M tokens, 10 concurrent, 600 RPM), https://docs.byteplus.com/en/docs/ModelArk/1901652 (`seedance-1-0-pro-fast-251015`), https://www.byteplus.com/en/blog/seedance-1-0-pro-guide-api-pricing (lite ids, base URL, token formula), https://www.byteplus.com/en/blog/dreamina-seedance2-0 (Apr 14 2026 GA), https://ai.byteplus.com/en/activity/seedance2-0 (2.0 and 2.0 mini listed, 480P/720P/1080P/4K on Dreamina consumer plans), https://www.byteplus.com/en/product/seedance ("Dreamina-seedance-2.5 API Now Fully Available"), https://seed.bytedance.com/en/seedance2_5, https://en.wikipedia.org/wiki/Seedance_2.0 (2.5 launch Jul 31 2026). The `2-5-260628` and `2-0-260128` id strings also appear on https://aiseedance25.app/seedance-2-5-api and https://seedance2-video.com/seedance-2-0-release-notes (secondary). Deprecation dates: BytePlus has a "Model deprecations - 2025" page (https://docs.byteplus.com/en/docs/ModelArk/2172669) that did not render for me; I found no announced offline date for any Seedance id. UNVERIFIED whether 1.0 Lite is still callable.

Important restrictions (BytePlus docs nav and search snippets): "Dreamina Seedance 2.5 and 2.0 series models do not support directly uploading reference images or videos that contain real human faces"; portrait generation needs a separate "Advanced Creation Rights" purchase (https://docs.byteplus.com/en/docs/ModelArk/2608626, https://docs.byteplus.com/en/docs/modelark/2377608). BytePlus is not available in the United States (BytePlus blog); third parties add Canada, UK, Australia, NZ (UNVERIFIED).

### 2.2 Endpoints and auth

Base URLs: BytePlus international `https://ark.ap-southeast.bytepluses.com/api/v3` (BytePlus blog); Volcengine China `https://ark.cn-beijing.volces.com/api/v3` (widely documented, UNVERIFIED from a fetched vendor page in this session). Auth: `Authorization: Bearer $ARK_API_KEY`.

Paths (official `volcengine-python-sdk`, `volcenginesdkarkruntime/resources/content_generation/tasks.py`):

| Purpose          | Method and path                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------- |
| Create           | `POST /contents/generations/tasks`                                                            |
| Retrieve         | `GET /contents/generations/tasks/{task_id}`                                                   |
| List             | `GET /contents/generations/tasks?page_num=&page_size=&status=&task_ids=&model=&service_tier=` |
| Cancel or delete | `DELETE /contents/generations/tasks/{task_id}`                                                |
| Webhook          | `callback_url` in the create body                                                             |

BytePlus doc page titles confirm the same four operations: "Create a video generation task" (https://docs.byteplus.com/en/docs/ModelArk/1520757), "Retrieve a video generation task" (.../1521309), "List video generation tasks", "Cancel or delete a video generation task" (.../1521720).

### 2.3 Request parameters

Top-level fields accepted by the create call (SDK source, defaults and ranges from the ComfyUI router mirror of the ModelArk schema):

| Param                      | Type    | Values / notes                                                                                                                                        |
| -------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                    | string  | one id from 2.1                                                                                                                                       |
| `content`                  | array   | items below; at least one `text` item                                                                                                                 |
| `duration`                 | integer | `-1` (auto) or 4 to 30 (2.5), 4 to 15 (2.0 family), 4 to 12 (1.5 Pro), 2 to 12 (1.0 Pro). Default 5.                                                  |
| `resolution`               | string  | `480p`, `720p` (default), `1080p`, `4k` (per model; 2.0 family tops at 720p on the API)                                                               |
| `ratio`                    | string  | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `9:21`, `adaptive` (default `adaptive` on 2.x; with an image input `adaptive` follows the image)         |
| `generate_audio`           | boolean | default `true`; false yields a silent video (2.x and 1.5 Pro)                                                                                         |
| `watermark`                | boolean | default `false`                                                                                                                                       |
| `seed`                     | integer | `-1` (random, default) to 4294967295                                                                                                                  |
| `camera_fixed`             | boolean | default false; documented on 2.0 mini and 1.x, not on 2.5                                                                                             |
| `return_last_frame`        | boolean | default false; success response then includes `content.last_frame_url` (PNG)                                                                          |
| `frames`                   | integer | SDK-only alternative to duration (UNVERIFIED for Seedance 2.x)                                                                                        |
| `output_format`            | string  | `mp4` (default) or `mov` (2.5)                                                                                                                        |
| `service_tier`             | string  | `default` or `flex` (cheaper, lower priority; UNVERIFIED pricing)                                                                                     |
| `priority`                 | integer | SDK field, undocumented                                                                                                                               |
| `execution_expires_after`  | integer | seconds, 3600 to 259200; task is dropped if not finished                                                                                              |
| `callback_url`             | string  | webhook                                                                                                                                               |
| `draft`                    | boolean | SDK field; pairs with a `draft_task` content item (`{ "type": "draft_task", "draft_task": { "id" } }`) to regenerate from a draft, UNVERIFIED for 2.x |
| `omni_reference_task_type` | string  | SDK field, undocumented (likely `reference` / `editing` / `extension`, which are the `task` values fal exposes; UNVERIFIED)                           |
| `tools`                    | array   | SDK field `[{ "type": ... }]`, undocumented                                                                                                           |
| `safety_identifier`        | string  | end-user id for abuse tracking                                                                                                                        |

Content items (SDK `create_task_content_param.py`): `{ "type": "text", "text" }`, `{ "type": "image_url", "image_url": { "url" }, "role" }`, `{ "type": "video_url", "video_url": { "url" }, "role" }`, `{ "type": "audio_url", "audio_url": { "url" }, "role" }`. Roles: `first_frame`, `last_frame`, `reference_image`, `reference_video`, `reference_audio` (router schema). Reference assets are addressed in the prompt as `@Image1`, `@Video1`, `@Audio1` (fal docs for 2.0; BytePlus prompt guides use the same convention per search snippets). URLs may be https or base64 data URIs. 2.5 limits (fal, which fronts the same model): up to 30 images at 30 MB, 10 videos at 200 MB (1.8 to 30.2 s, 300 to 6000 px, 24 to 60 fps), 10 audio at 15 MB, 50 files total, at least one image or video for a reference task. 2.0 limits: 9 images, 3 videos (2 to 15 s combined), 3 audio (15 s combined), 12 files total.

Video-to-video: extension and editing are expressed as reference tasks whose input is a `video_url`; fal exposes `task: reference | editing | extension` on the 2.5 reference endpoint, and BytePlus marketing describes "extend scenes forward or backward" and "targeted video editing". The exact ModelArk field selecting the task kind is the `omni_reference_task_type` SDK parameter (UNVERIFIED value list).

Camera control: no bracket syntax; `camera_fixed: true` locks the camera on models that support it, otherwise describe motion in the prompt. Prompt optimiser: none exposed. Number of outputs: one per task. fps: not a request field; output is 24 fps (token formula uses 24). Legacy 1.0 Lite accepted `--ratio`, `--resolution`, `--duration`, `--camerafixed`, `--seed`, `--watermark` as text inside the prompt.

### 2.4 Task lifecycle

Statuses (SDK `content_generation_task.py`): `queued`, `running`, `succeeded`, `failed`, `cancelled`. BytePlus docs also use `expired` when `execution_expires_after` elapses (UNVERIFIED wording, seen only in a search-result title). No progress percentage. Task object fields: `id`, `model`, `status`, `created_at`, `updated_at`, `seed`, `service_tier`, `resolution`, `ratio`, `duration`, `frames`, `content: { video_url, last_frame_url }`, `usage: { completion_tokens, total_tokens }`, `error: { code, message }`. The `video_url` is a temporary link; BytePlus tutorials state 24-hour validity (UNVERIFIED in this session, could not render the page). Cancel only works on `queued` tasks; delete on finished ones (same semantics as MiniMax V2; UNVERIFIED for ModelArk beyond the shared `DELETE` route).

### 2.5 Streaming or progressive delivery

None. ModelArk video generation is a batch task API; no partial frames, no chunked delivery, no WebSocket. ByteDance Seed lists a separate model named "SeedRealtime" on seed.bytedance.com, but its page did not render and nothing ties it to Seedance video output; treat it as unrelated (UNVERIFIED). Dreamina's consumer "long-video mode" (up to 3 minutes) is a product feature, not an API stream.

### 2.6 Output

MP4 by default (`output_format: mov` on 2.5), 24 fps, H.264 (UNVERIFIED codec, inferred from the 1.8 to 30.2 s / 24 to 60 fps input rules and fal `content_type: video/mp4`). Audio track present unless `generate_audio: false`. Watermark off by default (`watermark` flag). Optional `last_frame_url` PNG. Retention: temporary URL (24 h per BytePlus tutorial, UNVERIFIED), tasks listable while they exist.

### 2.7 Pricing, latency, limits

Billing is per token: `tokens = width * height * fps(24) * duration_seconds / 1024`, with input video seconds added for reference-video jobs (`(input_video_seconds + output_seconds) * w * h * 24 / 1024`).

| Model                               | BytePlus list price                                                                                                                                              | Per-second equivalents                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `dreamina-seedance-2-5-260628`      | $10.70 per M tokens without video input (cellcog.ai citing the BytePlus rate card; UNVERIFIED, BytePlus pricing page did not render)                             | about $0.10/s at 480p, $0.23/s at 720p                  |
| `dreamina-seedance-2-0-260128`      | resource packs: $4.30 per M tokens with video input, $7.00 per M without (720p); $4.70 / $7.70 at 1080p (lumiying.com and kingy.ai quoting BytePlus; UNVERIFIED) | roughly $0.15/s at 720p without video input             |
| `dreamina-seedance-2-0-fast-260128` | "Fast packs" $3.30 per M tokens (kingy.ai; UNVERIFIED)                                                                                                           |                                                         |
| `seedance-1-0-pro-250528`           | $2.50 per M tokens (BytePlus doc 1587798, VERIFIED)                                                                                                              | 1080p 16:9 5 s = 244,800 tokens = $0.61 (BytePlus blog) |
| Volcengine China 2.5                | CNY 70 per M tokens without video input, CNY 42 with (cellcog.ai; UNVERIFIED)                                                                                    |                                                         |

Rate limits: 10 concurrent tasks per model version per account and 600 RPM on task creation (BytePlus 1.0 Pro doc page, VERIFIED for 1.0; 2.x limits not rendered, UNVERIFIED). Latency: BytePlus publishes no numbers; fal/aggregator posts put 2.0 at roughly 1 to 3 minutes for a 10 s 720p clip (UNVERIFIED). `service_tier: flex` exists for discounted lower priority.

### 2.8 Minimal JSON

Submit (2.5, first frame plus reference audio):

```json
POST https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks
{ "model": "dreamina-seedance-2-5-260628",
  "content": [
    { "type": "text", "text": "@Image1 walks toward camera and speaks in sync with @Audio1" },
    { "type": "image_url", "image_url": { "url": "https://example.com/a.png" }, "role": "first_frame" },
    { "type": "audio_url", "audio_url": { "url": "https://example.com/line.mp3" }, "role": "reference_audio" }
  ],
  "duration": 8, "resolution": "720p", "ratio": "adaptive",
  "generate_audio": true, "watermark": false, "seed": -1,
  "return_last_frame": false, "callback_url": "https://my.app/hook" }
```

Create response: `{ "id": "cgt-2026...-xxxxx" }` (task id prefix `cgt-`, from BytePlus blog "returns `id` field"; prefix UNVERIFIED).

Poll pending: `{ "id": "cgt-...", "model": "dreamina-seedance-2-5-260628", "status": "running", "created_at": 1789000000, "updated_at": 1789000030 }`

Poll done:

```json
{
  "id": "cgt-...",
  "model": "dreamina-seedance-2-5-260628",
  "status": "succeeded",
  "content": {
    "video_url": "https://ark-content-generation-...tos.../video.mp4",
    "last_frame_url": null
  },
  "seed": 1094575694,
  "resolution": "720p",
  "ratio": "16:9",
  "duration": 8,
  "frames": 193,
  "usage": { "completion_tokens": 172800, "total_tokens": 172800 },
  "created_at": 1789000000,
  "updated_at": 1789000150
}
```

Field names are from the SDK task type; example values are illustrative.

### 2.9 Aggregators

| Aggregator | Endpoints                                                                                                                                                                                                                    | Knob parity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fal.ai     | `bytedance/seedance-2.5/{text-to-video,image-to-video,reference-to-video}` plus `/us/` variants (US-hosted); `bytedance/seedance-2.0/{text-to-video,image-to-video,reference-to-video}`, `/fast/...`, `/mini/...`, `/us/...` | Flat fields: `prompt`, `image_url`, `end_image_url`, `image_urls`, `video_urls`, `audio_urls`, `task` (`reference`, `editing`, `extension`, 2.5 only), `resolution` (`480p`, `720p`, plus `1080p` on 2.5), `duration` string `"auto"` or `"4"` to `"30"`, `aspect_ratio` (`auto`, `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, `9:16`; no `9:21`), `generate_audio`, `bitrate_mode` (`standard`, `high`, 2.5 only), `seed`, `end_user_id`. Missing vs direct: `watermark`, `camera_fixed`, `return_last_frame`, `service_tier`, `callback_url` (fal has its own queue webhooks). Pricing: 2.5 $0.0214 per 1000 tokens (about $0.22/s 480p, $0.47/s 720p, about $1.16/s 1080p); 2.0 standard $0.3034/s t2v, fast $0.2419/s, reference-video input at 0.6x. Note fal's 2.5 per-second price is roughly double BytePlus direct. |
| Replicate  | `bytedance/seedance-2.5`, `bytedance/seedance-2.0` (1.4M+ runs)                                                                                                                                                              | Schema page did not render; README says up to 30 images / 10 videos / 10 audio, duration 4 to 30 or `-1`, aspect ratio incl. adaptive, audio toggle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Sources: https://fal.ai/models/bytedance/seedance-2.5/reference-to-video/api, https://fal.ai/models/bytedance/seedance-2.5/image-to-video/api, https://fal.ai/models/bytedance/seedance-2.5/text-to-video, https://github.com/fal-ai/seedance-2.0-api, https://fal.ai/models/bytedance/seedance-2.0/mini/image-to-video/api, https://fal.ai/explore/bytedance, https://replicate.com/bytedance/seedance-2.5/readme.

---

## Part 3: Cross-vendor observations for the `VideoGenerator` design

Uniform across both direct APIs (and fal): async task with `create`, `get`, `list`, `delete/cancel`; text prompt; first frame and last frame images; N reference images, videos and audio via a role-tagged `content[]` array (MiniMax V2 and ModelArk use nearly identical item shapes: `{ type, image_url: { url }, role }`); integer `duration` in seconds; string `resolution`; aspect `ratio` with `adaptive`; `callback_url`; statuses `queued` / `running` / `succeeded` / `failed` / `cancelled`; result as a temporary URL on the task object; native audio in the output.

Vendor-only: MiniMax has no `seed`, no audio toggle, no watermark toggle, no `9:21`, a `2K` tier, an `extra.prompt_expansion_mode`, a separate regeneration (upscale) task, a `challenge` handshake on webhooks, and legacy V1 with bracket camera commands and `prompt_optimizer`. Seedance has `generate_audio`, `watermark`, `seed`, `camera_fixed`, `return_last_frame`, `service_tier`, `execution_expires_after`, `output_format`, `-1` auto duration, token billing, and the `@Image1` reference addressing.

Surprises: MiniMax's Hailuo models are already "Legacy" less than a year after release and the V1 and V2 wire formats are incompatible (capitalised vs lowercase statuses, `file_id` plus files API vs inline URL). `MiniMax-H3-Max` is a fal-trained model that MiniMax sells first-party. Seedance 2.x direct API tops out at 720p (2.0) while consumer Dreamina advertises 1080p/4K; 2.5's 1080p/4k on the router schema is unconfirmed on the BytePlus rate card. BytePlus blocks real human faces in reference inputs by default and is unavailable in the US.

## Sources

MiniMax (vendor):

- https://platform.minimax.io/docs/guides/video-generation and .md
- https://platform.minimax.io/docs/guides/models-intro.md
- https://platform.minimax.io/docs/guides/pricing-paygo.md
- https://platform.minimax.io/docs/guides/pricing-video
- https://platform.minimax.io/docs/guides/rate-limits
- https://platform.minimax.io/docs/guides/video-prompt.md
- https://platform.minimax.io/docs/release-notes/models.md
- https://platform.minimax.io/docs/release-notes/apis.md
- https://platform.minimax.io/docs/api-reference/video-generation-v2-create
- https://platform.minimax.io/docs/api-reference/video-generation-v2-query
- https://platform.minimax.io/docs/api-reference/video-generation-v2-list.md
- https://platform.minimax.io/docs/api-reference/video-generation-v2-delete.md
- https://platform.minimax.io/docs/api-reference/video-generation-v2-h3-context-ir
- https://platform.minimax.io/docs/api-reference/video-generation-v2-regeneration
- https://platform.minimax.io/docs/api-reference/video-generation-t2v
- https://platform.minimax.io/docs/api-reference/video-generation-i2v
- https://platform.minimax.io/docs/api-reference/video-generation-fl2v.md
- https://platform.minimax.io/docs/api-reference/video-generation-s2v
- https://platform.minimax.io/docs/api-reference/video-generation-query
- https://platform.minimax.io/docs/api-reference/video-generation-download
- https://platform.minimax.io/docs/api-reference/file-management-retrieve
- https://platform.minimax.io/docs/llms.txt
- https://www.minimax.io/blog/minimax-h3
- https://www.minimax.io/news/minimax-h3-open-source
- https://www.minimax.io/news/minimax-hailuo-23
- https://github.com/MiniMax-AI/MiniMax-MCP (base URLs)

ByteDance / BytePlus (vendor):

- https://docs.byteplus.com/en/docs/ModelArk/1520757 (create), /1521309 (retrieve), /1521720 (cancel or delete), /1330310 (model list), /2607688 (Seedance 2.5 tutorial), /2291680 (Seedance 2.0 tutorial), /2608626 (portrait videos), /2377608 (advanced creation rights), /2172669 (deprecations 2025): navigation shell only
- https://docs.byteplus.com/en/docs/ModelArk/1587798 (seedance-1.0-pro, rendered)
- https://docs.byteplus.com/en/docs/ModelArk/1901652 (seedance-1.0-pro-fast, rendered)
- https://www.byteplus.com/en/blog/seedance-1-0-pro-guide-api-pricing
- https://www.byteplus.com/en/blog/dreamina-seedance2-0
- https://ai.byteplus.com/en/activity/seedance2-0
- https://www.byteplus.com/en/product/seedance
- https://seed.bytedance.com/en/seedance2_5
- https://seed.bytedance.com/en/seedance2_0
- https://github.com/volcengine/volcengine-python-sdk (resources/content_generation/tasks.py, types/content_generation/content_generation_task.py, create_task_content_param.py)

Aggregators and secondary:

- https://blog.fal.ai/introducing-h3-max-by-fal/
- https://fal.ai/models/minimax/h3/text-to-video/api
- https://fal.ai/models/minimax/h3/reference-to-video/api
- https://fal.ai/models/minimax/h3-max/text-to-video
- https://fal.ai/models/minimax/h3-max/image-to-video/api
- https://fal.ai/models/fal-ai/minimax/hailuo-2.3-fast/pro/image-to-video/api
- https://fal.ai/models/bytedance/seedance-2.5/reference-to-video/api
- https://fal.ai/models/bytedance/seedance-2.5/image-to-video/api
- https://fal.ai/models/bytedance/seedance-2.5/text-to-video
- https://fal.ai/models/bytedance/seedance-2.0/mini/image-to-video/api
- https://fal.ai/explore/bytedance
- https://github.com/fal-ai/seedance-2.0-api
- https://replicate.com/minimax, https://replicate.com/minimax/h3, https://replicate.com/minimax/hailuo-2.3
- https://replicate.com/bytedance/seedance-2.5/readme
- https://docs.comfy.org/development/comfy-router/models/byteplus and per-model `/code` pages (ModelArk id and schema mirror)
- https://en.wikipedia.org/wiki/Seedance_2.0
- https://cellcog.ai/blog/seedance-2-5-pricing/ (UNVERIFIED pricing)
- https://kingy.ai/ai/byteplus-review-seedance-2-0-turns-byteplus-into-a-serious-ai-video-platform/ (UNVERIFIED pricing)
- https://lumiying.com/resource/seedance-2-api (UNVERIFIED pricing)
- https://aiseedance25.app/seedance-2-5-api (UNVERIFIED id confirmation)
- https://seedance2-video.com/seedance-2-0-release-notes (UNVERIFIED dates)
