# Subagent report: video generation, Runway, Kling, Luma (2026-09-19)

Raw report. Summarised in `../video-generation.md`.

Method note: Runway and Kling both publish machine readable markdown mirrors of their docs (`docs.dev.runwayml.com/llms.txt`, `kling.ai/document-api/llms.txt`), so nearly everything below is primary source. Luma's older `docs.lumalabs.ai` is legacy; the live docs are `docs.agents.lumalabs.ai`. Anything not confirmed from a vendor page is marked UNVERIFIED.

---

## 0. Corrections to the sibling reports

| Claim carried in                                                            | Verdict                                                                                                                                                              |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runway line is Gen-4.5, Aleph 2.0, Act-Two, realtime Characters over WebRTC | Confirmed. Exact ids `gen4.5`, `aleph2`, `act_two`, `gwm1_avatars`. Characters is WebRTC, with LiveKit as the room layer.                                            |
| Runway is NOT on fal                                                        | Confirmed for fal. Corrected for Replicate: `replicate.com/runwayml/gen-4.5` exists, so Runway is on Replicate.                                                      |
| Kling line is 3.0, 3.0 Omni, 3.0 Turbo, Motion Control                      | Confirmed, and incomplete. Kling O1, 2.6 and 2.5 Turbo are still first class in the capability map.                                                                  |
| Luma is Ray3.2                                                              | Confirmed, id `ray-3.2`. But the API moved: Dream Machine / Ray2 at `api.lumalabs.ai` is deprecated, Ray3.2 lives on the Luma Agents API at `agents.lumalabs.ai/v1`. |
| (new) Runway is a single vendor surface                                     | Wrong. Runway's API now routes third party models too: Veo 3.1, Seedance 2.x, Hailuo 3, Wan 3, Grok Imagine 1.5, Gemini Omni Flash. It is partly an aggregator.      |
| (new) Kling takes `cfg_scale` and `camera_control`                          | Those are v1.x fields. The Kling 3.0 API has neither.                                                                                                                |

---

# RUNWAY

Base URL `https://api.dev.runwayml.com`. Auth `Authorization: Bearer <api secret>`. Required version header `X-Runway-Version: 2024-11-06`. ([ai-context](https://docs.dev.runwayml.com/ai-context.md))

## 1. Models

Runway's own models plus hosted third party models, all behind the same endpoints. ([models guide](https://docs.dev.runwayml.com/guides/models.md))

| Model id                                                       | Input                | Endpoint                                  | Note                                                      |
| -------------------------------------------------------------- | -------------------- | ----------------------------------------- | --------------------------------------------------------- |
| `gen4.5`                                                       | text or image        | `/v1/image_to_video`, `/v1/text_to_video` | Runway flagship. Pro/HDR output formats.                  |
| `gen4_turbo`                                                   | image                | `/v1/image_to_video`                      | The fast, cheap Runway tier.                              |
| `aleph2`                                                       | video + text/image   | `/v1/video_to_video`                      | Aleph 2.0, the video editing model.                       |
| `act_two`                                                      | image or video       | `/v1/character_performance`               | Act-Two performance transfer.                             |
| `gwm1_avatars`                                                 | text conversation    | `/v1/realtime_sessions`                   | Realtime Characters, GWM-1.                               |
| `veo3.1`, `veo3.1_fast`                                        | text or image        | `/v1/image_to_video`                      | Hosted Google. Only models here with an audio price tier. |
| `seedance2_5`, `seedance2`, `seedance2_fast`, `seedance2_mini` | text, image or video | `/v1/image_to_video`                      | Hosted ByteDance.                                         |
| `hailuo3`, `h3_max`                                            | text or image        | `/v1/image_to_video`                      | Hosted MiniMax.                                           |
| `wan3`, `wan3_prime`                                           | text or image        | `/v1/image_to_video`                      | Hosted Alibaba.                                           |
| `grok_imagine_1_5`                                             | text or image        | `/v1/image_to_video`                      | Hosted xAI.                                               |
| `gemini_omni_flash`, `gemini_omni_flash_1.1`                   | text, image or video | `/v1/text_to_video`                       | Hosted Google.                                            |
| `happyhorse_1_0`                                               | text or image        | `/v1/image_to_video`                      | Unattributed.                                             |
| `magnific_video_upscaler_creative`                             | video                | `/v1/video_upscale`                       | 30s max.                                                  |
| `enhance_frame_rate`                                           | video                | `/v1/video_upscale`                       | 300s max, 1 credit per 2s.                                |
| `ruby`                                                         | SDR video            | `/v1/video_to_hdr`                        | 30s max, under 4096px per side.                           |

No deprecation notices appear in the models guide. Gen-3 ids are simply gone from the list, which is the de facto deprecation. Fast tier: `gen4_turbo` for Runway's own line (5 credits/s versus 12 for `gen4.5`); among hosted models `seedance2_fast`, `seedance2_mini` and `veo3.1_fast` are the fast tiers.

## 2. Endpoints

All generation is asynchronous: POST returns a task, you poll.

| Purpose                                | Endpoint                                                                                                          |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| text to video                          | `POST /v1/text_to_video`                                                                                          |
| image to video, incl. first/last frame | `POST /v1/image_to_video`                                                                                         |
| video to video, incl. extend           | `POST /v1/video_to_video`                                                                                         |
| character / performance transfer       | `POST /v1/character_performance`                                                                                  |
| upscale                                | `POST /v1/image_upscale`, `POST /v1/video_upscale`                                                                |
| SDR to HDR                             | `POST /v1/video_to_hdr`                                                                                           |
| text to image                          | `POST /v1/text_to_image`                                                                                          |
| audio                                  | `POST /v1/text_to_speech`, `/v1/speech_to_speech`, `/v1/sound_effect`, `/v1/voice_dubbing`, `/v1/voice_isolation` |
| poll task                              | `GET /v1/tasks/{id}`                                                                                              |
| cancel or delete task                  | `DELETE /v1/tasks/{id}`                                                                                           |
| upload asset                           | `POST /v1/uploads`                                                                                                |
| avatars                                | `POST /v1/avatars`, `GET/PATCH /v1/avatars/{id}`                                                                  |
| realtime session                       | `POST /v1/realtime_sessions`, `GET /v1/realtime_sessions/{id}`, `POST /v1/realtime_sessions/{id}/consume`         |
| conversation history                   | `GET /v1/avatars/{id}/conversations[/{conversationId}]`                                                           |

Shape note: modality picks the endpoint, model picks the behaviour. Extend is not its own endpoint, it is `mode: "extend"` on `/v1/video_to_video` for `seedance2_5`. First and last frame are not separate endpoints either, they are positions inside `promptImage` on `/v1/image_to_video`.

Webhooks: none. Polling only. Confirmed absent from `ai-context.md`, `core-api.txt` and `api.md`.

## 3. Request parameters

Common fields across the video endpoints: `model`, `promptText`, `promptImage`, `ratio`, `duration`, `seed`, `contentModeration`, `references`. ([core-api](https://docs.dev.runwayml.com/_llms-txt/core-api.txt), [api.md](https://docs.dev.runwayml.com/api.md))

First and last frame, expressed as position inside a single field:

```json
"promptImage": [
  { "uri": "https://example.com/a.jpg", "position": "first" },
  { "uri": "https://example.com/b.jpg", "position": "last" }
]
```

`position` is `"first"` or `"last"`. A bare string `promptImage` is the single starting image. References are a separate array, `"references": [{ "uri": "..." }]`, and on the image endpoint they carry an optional `tag` that the prompt addresses as `@tagName`.

Moderation:

```json
"contentModeration": { "publicFigureThreshold": "auto" | "low" }
```

`auto` is the default, `low` is less strict.

Ratios are pixel pairs, per model:

| Model                         | `ratio` values                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `gen4.5`, `gen4_turbo`        | `1280:720`, `720:1280`, `1104:832`, `960:960`, `832:1104`, `1584:672`                                                  |
| `veo3.1`, `veo3.1_fast`       | `1280:720`, `720:1280`, `1080:1920`, `1920:1080`                                                                       |
| `seedance2_5`                 | 18 pairs from `992:432` up to `1080:1920`                                                                              |
| `seedance2`                   | 24 pairs including 4K (`3840:2160`, `3840:3840`)                                                                       |
| `wan3`, `wan3_prime`          | 15 pairs plus `auto_480p`, `auto_720p`, `auto_1080p`                                                                   |
| `hailuo3`, `grok_imagine_1_5` | ratio strings, not pixel pairs: `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, plus `adaptive` (hailuo3) and `3:2`, `2:3` (grok) |

So the "Runway uses pixel pairs" rule holds for Runway's own models and breaks for some hosted ones. A `VideoGenerator` cannot assume a single ratio encoding even within one provider.

Durations: `gen4.5` and `gen4_turbo` take an integer in 2 to 10 (per `api.md`). Note a conflict: `core-api.txt` says "Gen-4.5 supports up to 30 seconds at 1080p". UNVERIFIED which is current; treat 10s as the safe bound and probe the API. `hailuo3` 5 to 15, `wan3` 2 to 30, `grok_imagine_1_5` 1 to 15, seedance variants accept an integer or the string `"auto"`.

Other knobs: `seed` (integer, optional), `audio` boolean appears in the seedance2_5 example, professional output format selection for `gen4.5` and `aleph2` (`mp4` default H.264, `prores`, `png_sequence`, `sdr_rec709_10bit`, `hdr10`, `hlg`, `hdr_pq_12bit_master`, `hdr_prores`, `hdr_png_sequence`, `hdr_exr_sequence`, `hdr_exr_acescg_sequence_1_3`, `hdr_exr_acescg_sequence_2_0`). No `negative_prompt`, no `cfg_scale`, no camera control DSL, no `loop`.

## 4. Task lifecycle

Status vocabulary from `ai-context.md`: `PENDING`, `THROTTLED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`. `THROTTLED` is real and load bearing: exceeding your tier concurrency puts the task in `THROTTLED` rather than rejecting it ([tiers](https://docs.dev.runwayml.com/usage/tiers/)). The `api.md` summary rendered `QUEUED` and `CANCELED` instead; the spelling of the cancelled state is UNVERIFIED, handle both.

Task fields: `id`, `status`, `createdAt`, `updatedAt`, `output` (array of URLs), `progress`, `failure`, `failureCode`, `estimatedDurationSeconds`. The scale of `progress` is UNVERIFIED, one doc render showed 0 to 100 and Runway's SDKs historically expose a 0..1 float; read the OpenAPI at `docs.dev.runwayml.com/openapi.json` before fixing a schema.

Output URL expiry, quoted: "These URLs are ephemeral: they will expire within 24-48 hours of accessing the API." ([outputs](https://docs.dev.runwayml.com/assets/outputs/)) Download and store anything you intend to keep.

`DELETE /v1/tasks/{id}` cancels an active task. Credits already spent are not recovered and the task cannot be restarted.

## 5. Streaming

For the batch video endpoints there is no streaming and no progressive delivery. Nothing arrives before `SUCCEEDED`; the only in-flight signal is the `progress` field on the poll. No webhook either.

The realtime product is separate. Characters streams live over **WebRTC**, with LiveKit as the room and media routing layer ([characters](https://docs.dev.runwayml.com/_llms-txt/characters.txt)). Flow:

1. Server `POST /v1/realtime_sessions` with the avatar config.
2. Client polls `GET /v1/realtime_sessions/{id}` until state `READY`.
3. `POST /v1/realtime_sessions/{id}/consume`, once only, returns the WebRTC room URL, token and room name.
4. Client joins the LiveKit room for bidirectional audio and video.

Session states: `NOT_READY` to `READY` to `RUNNING` to `COMPLETED`, or `FAILED` / `CANCELLED`. Max session duration 5 minutes. Streams: avatar video out (lip synced), user microphone in, optional user webcam or screen share in. No published latency SLA.

## 6. Audio

Runway's own video models do not generate audio. The models guide is explicit that video models do not produce audio and that audio is handled separately. The exceptions are hosted: `veo3.1` and `veo3.1_fast` have distinct audio and no-audio price tiers, and the seedance2_5 example carries `"audio": true`. Characters (`gwm1_avatars`) outputs video plus audio by nature.

Separate audio products: `/v1/text_to_speech` (`eleven_v3`, `eleven_multilingual_v2`, `seed_audio`), `/v1/sound_effect`, `/v1/speech_to_speech`, `/v1/voice_dubbing`, `/v1/voice_isolation`. Lip sync as such is not an endpoint; `act_two` on `/v1/character_performance` is the performance transfer product.

## 7. Output

Default container mp4 / H.264. `gen4.5` and `aleph2` additionally offer ProRes .mov, PNG sequence plus .wav, HEVC Main 10 Rec.709, and the HDR and EXR/ACEScg families listed above. Resolution follows `ratio`, up to 4K on the seedance models. Watermark policy and retention beyond the 24 to 48 hour URL expiry are UNVERIFIED (not stated on the outputs page).

## 8. Pricing, limits

1 credit = $0.01 ([pricing](https://docs.dev.runwayml.com/guides/pricing.md)).

| Model                                  | Credits/s                                                            | USD/s                 | Minimum    |
| -------------------------------------- | -------------------------------------------------------------------- | --------------------- | ---------- |
| `gen4_turbo`                           | 5                                                                    | $0.05                 |            |
| `act_two`                              | 5                                                                    | $0.05                 |            |
| `gen4.5`                               | 12                                                                   | $0.12                 |            |
| `aleph2`                               | 28                                                                   | $0.28                 | 56 credits |
| `veo3.1` no audio / audio              | 20 / 40                                                              | $0.20 / $0.40         |            |
| `veo3.1_fast` no audio / audio         | 10 / 15                                                              | $0.10 / $0.15         |            |
| `seedance2_5` 480p / 720p / 1080p      | 20 / 30 / 68 output, plus half that per second of input or reference | $0.20 / $0.30 / $0.68 | 80 credits |
| `seedance2` 480p-720p / 1080p / 4K     | 36 / 40 / 150                                                        | $0.36 / $0.40 / $1.50 |            |
| `seedance2_fast`                       | 29                                                                   | $0.29                 |            |
| `seedance2_mini`                       | 16                                                                   | $0.16                 | 64 credits |
| `wan3` 480p / 720p / 1080p             | 5 / 10 / 20                                                          | $0.05 / $0.10 / $0.20 |            |
| `hailuo3` 768p / 2K                    | 10 / 15, plus 2 per reference image                                  | $0.10 / $0.15         |            |
| `h3_max` 480p / 768p                   | 5 / 8                                                                | $0.05 / $0.08         |            |
| `grok_imagine_1_5` 480p / 720p / 1080p | 10 / 16 / 29, plus 1 per reference                                   | $0.10 / $0.16 / $0.29 |            |
| `happyhorse_1_0` 720p / 1080p          | 15 / 30                                                              | $0.15 / $0.30         |            |
| `gemini_omni_flash`                    | 10                                                                   | $0.10                 |            |
| `enhance_frame_rate`                   | 0.5                                                                  | $0.005                |            |

Note that `gen4.5` at $0.12/s is cheaper than most hosted models on the same platform.

Tiers ([tiers](https://docs.dev.runwayml.com/usage/tiers/)):

| Tier | Max concurrency | Max gens/day  | Max spend/mo | Unlocks at   |
| ---- | --------------- | ------------- | ------------ | ------------ |
| 1    | 1-2             | 50-200        | $100         | start        |
| 2    | 3               | 500-1,000     | $500         | $50 spent    |
| 3    | 5               | 1,000-2,000   | $2,000       | $100 spent   |
| 4    | 10              | 5,000-10,000  | $20,000      | $1,000 spent |
| 5    | 20              | 25,000-30,000 | $100,000     | $5,000 spent |

No requests-per-minute limit as long as you stay inside the daily generation cap. Exceeding the daily cap gives `429`. Exceeding concurrency gives `THROTTLED` tasks, not an error. Video and image models share one concurrency pool. Characters credits: 600 free credits is roughly 30 minutes of Character video, billed while the worker is active.

No latency claims are published.

## 9. Minimal JSON

Create:

```http
POST https://api.dev.runwayml.com/v1/image_to_video
Authorization: Bearer <secret>
X-Runway-Version: 2024-11-06
Content-Type: application/json
```

```json
{
  "model": "gen4.5",
  "promptText": "a hot air balloon drifts over a valley at sunrise",
  "promptImage": [{ "uri": "https://example.com/first.jpg", "position": "first" }],
  "ratio": "1280:720",
  "duration": 5,
  "seed": 12345,
  "contentModeration": { "publicFigureThreshold": "auto" }
}
```

Create response / pending poll (`GET /v1/tasks/{id}`):

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "RUNNING",
  "createdAt": "2026-09-19T12:00:00Z",
  "progress": 0.42
}
```

Succeeded poll:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "SUCCEEDED",
  "createdAt": "2026-09-19T12:00:00Z",
  "output": ["https://dnznrvs05pmza.cloudfront.net/....mp4"]
}
```

Failure carries `"status": "FAILED"` plus `failure` (message) and `failureCode`.

## 10. Aggregators

- **fal: absent.** Confirmed. No Runway, RunwayML, Gen-4, Aleph or Act-Two entries in fal's video model catalogue.
- **Replicate: present.** `replicate.com/runwayml/gen-4.5` is a first party Replicate page with a text-to-video README. Whether the full knob set (`contentModeration`, pro output formats, `position` keyframes) is exposed there is UNVERIFIED; Replicate wrappers typically flatten to prompt, image, duration, ratio.

---

# KLING

Base URL `https://api-singapore.klingai.com`, which the docs say replaced the legacy `https://api.klingai.com`. Auth `Authorization: Bearer <API Key>`; the older scheme, still supported, is a JWT signed HS256 with `iss` = AccessKey, `exp` = now + 1800s, `nbf` = now - 5s, sent in the same header. ([authentication](https://kling.ai/document-api/api/get-started/authentication.md))

There is no version header. **The model version is in the URL path.** This is the single biggest structural fact about the Kling API.

## 1. Models

From the [capability map](https://kling.ai/document-api/guides/capability-map/video.md) and [pricing](https://kling.ai/document-api/pricing/base/video.md):

| Model           | Path segment      | Res             | Duration | Native audio       | Notes                                              |
| --------------- | ----------------- | --------------- | -------- | ------------------ | -------------------------------------------------- |
| Kling 3.0       | `kling-3.0`       | 720p, 1080p, 4k | 3-15s    | yes                | flagship, multi-shot                               |
| Kling 3.0 Omni  | `kling-3.0-omni`  | 720p, 1080p, 4k | 3-15s    | yes                | all-in-one multimodal input: text, image and video |
| Kling 3.0 Turbo | `kling-3.0-turbo` | 720p, 1080p     | 3-15s    | yes                | the fast tier; no 4K                               |
| Kling O1        | `o1`              | 720p, 1080p     | 3-10s    | limited multi-shot |                                                    |
| Kling 2.6       | `2-6`             | 720p, 1080p     |          | yes                | only 2.6 has human voice control                   |
| Kling 2.5 Turbo | `2-5-turbo`       | 720p, 1080p     |          | no                 | oldest still documented                            |

No formal deprecation of models in the [changelog](https://kling.ai/document-api/updates/api.md); the only sunsets listed are video _effects_ (`magic_match_tree` on 2026-07-03, and seven effects including `kiss`, `fight`, `hug`, `3d_cartoon_1` on 2026-01-30). Launch dates: 3.0 Omni and V3 on 2026-02-25, Motion Control 3.0 on 2026-03-04, 3.0 Turbo plus Omni 4K and 15s reference video on 2026-06-17.

Fast tier: `kling-3.0-turbo`. Trade: it is the only 3.x tier that costs _more_ per second at 720p than base 3.0 (0.8 vs 0.6 Units), so Turbo buys latency, not money.

## 2. Endpoints

| Purpose                                  | Endpoint                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| text to video                            | `POST /text-to-video/kling-3.0`, `POST /text-to-video/kling-3.0-turbo`     |
| image to video (first and/or last frame) | `POST /image-to-video/kling-3.0`, `POST /image-to-video/kling-3.0-turbo`   |
| omni: video in, edit, extend, reference  | `POST /omni-video/kling-3.0-omni`                                          |
| motion control                           | `POST /motion-control/kling-3.0` (also `/api/video/motion-control/2-6`)    |
| multi element reference editing          | `/api/video/multi-elements`                                                |
| element management                       | `/api/video/3-0-omni/elements`                                             |
| lip sync                                 | `POST /v1/videos/lip-sync` (legacy flat shape)                             |
| face detection for lip sync              | `/api/video/lip-sync/face-detection`                                       |
| avatar                                   | `/api/video/avatar`, TTS at `/api/video/avatar/text-to-speech`             |
| audio                                    | `/api/video/audio-generation/text-to-audio`, `/video-to-audio`             |
| effects                                  | `/api/effects/video-effects`                                               |
| e-commerce solutions                     | apparel replicator, goods studio, video commerce, virtual try-on           |
| poll task                                | `GET /tasks?task_ids={id}` or `?external_task_ids={id}`                    |
| list tasks                               | `POST /tasks` with cursor pagination and `status` / `product_type` filters |
| account                                  | `/api/assets/account-usage`, billing deduction queries                     |

Cancel or delete: no cancel endpoint is documented. UNVERIFIED whether one exists.

Extend: not a separate endpoint. It is `base_video` inside the `contents` array on `/omni-video/kling-3.0-omni`. Upscale: no upscale endpoint; resolution is chosen at generation time (up to 4k).

Webhooks: yes, and good ones. See section 4.

## 3. Request parameters

The 3.x API abandoned the flat v1/v2 body. The new shape is three objects:

```json
{
  "contents": [ ... ],
  "settings": { ... },
  "options": { ... }
}
```

`contents` is a typed, discriminated array. Item `type` values:

| `type`            | Where                | Payload                                                          |
| ----------------- | -------------------- | ---------------------------------------------------------------- |
| `prompt`          | all                  | `text`, max 3072 chars (2500 recommended)                        |
| `first_frame`     | image-to-video, omni | `url`                                                            |
| `last_frame`      | image-to-video, omni | `url`                                                            |
| `element`         | all                  | `element_id`, `id`                                               |
| `refer_image`     | omni                 | style or scene reference image                                   |
| `feature_video`   | omni                 | motion or style reference video, multi-shot supported, up to 15s |
| `base_video`      | omni                 | the video to edit or extend                                      |
| `image` / `video` | motion control       | character appearance / motion reference                          |

So first versus last frame is expressed as **the item's type**, not a `position` field (contrast Runway) and not `image` / `image_tail` (contrast Kling v1.x).

`settings`:

| Field                   | Values                                                                   | Default |
| ----------------------- | ------------------------------------------------------------------------ | ------- |
| `resolution`            | `720p`, `1080p`, `4k`                                                    | `720p`  |
| `aspect_ratio`          | `16:9`, `9:16`, `1:1`                                                    | `16:9`  |
| `duration`              | integer 3-15 seconds                                                     | `5`     |
| `audio`                 | `native`, `original`, `off` (`original` on omni and motion control only) | `off`   |
| `multi_shot`            | boolean                                                                  | `true`  |
| `character_orientation` | motion control only, `image` or `video`, required                        |         |

`options`:

| Field                    | Meaning                                        |
| ------------------------ | ---------------------------------------------- |
| `callback_url`           | webhook target                                 |
| `external_task_id`       | your own idempotency/correlation id, queryable |
| `watermark_info.enabled` | boolean, default `false`                       |

Multi-shot prompt syntax on Turbo: `shot n, m, words`, up to 6 shots, each shot at least 1 second, each shot prompt up to 512 chars.

Gone from 3.x versus v1.x: `model_name` (now in the path), `cfg_scale` (2.x already dropped it), `mode` std/pro (replaced by `resolution`), `camera_control` with its type/config DSL, `negative_prompt`, `image_tail`, `static_mask`, `dynamic_masks`. Do not model these as Kling-generic. Aggregator docs that still show `model_name: "kling-v3-0"` and `cfg_scale` are describing their own wrapper, not the native API.

Motion control (`/motion-control/kling-3.0`) is Kling's performance transfer: it applies motion from a reference video to a character image. `character_orientation` decides which reference the output follows. Video duration 3-30s when following the video, 3-10s when following the image. 720p or 1080p only.

Lip sync is a separate legacy-shaped product: `POST /v1/videos/lip-sync` with `input.mode` of `text2video` or `audio2video`, `input.text` max 120 chars, `input.voice_language` `zh` or `en`, `input.voice_speed` 0.8 to 2.0, and `input.video_id` or `input.video_url`.

## 4. Task lifecycle

Status vocabulary: `submitted`, `processing`, `succeeded`, `failed`. Caution: the legacy v1 API used `succeed` (no "d"). If you talk to both generations, accept both. No progress fraction is documented.

Response envelope:

```json
{
  "code": 0,
  "message": "string",
  "request_id": "string",
  "data": {
    "id": "task_id",
    "status": "submitted|processing|succeeded|failed",
    "create_time": 1781080778802,
    "update_time": 1781080794151,
    "external_id": "string",
    "outputs": [{ "type": "video", "url": "...", "duration": "..." }],
    "billing": [{ "charge_type": "cash|unit", "amount": "..." }]
  }
}
```

Note `code` / `message` at the envelope level: HTTP 200 does not mean success, you must check `code == 0`. Error code 1303 is "parallel task over resource pack limit".

Retention, quoted: "Generated results will be cleared after 30 days. Please make sure to save them promptly." Output URLs are hotlink protected.

**Callbacks** ([protocol](https://kling.ai/document-api/api/get-started/callbacks.md)): set `options.callback_url`. All four statuses fire a callback. Signature verification uses Svix-style headers: `webhook-id`, `webhook-timestamp` (unix seconds, accept within 5 minutes), `webhook-signature` (`version,signature`, multiple space separated during a 7 day rotation grace period). Signed content is `{id}.{timestamp}.{rawBody}`, HMAC-SHA256 with the secret after stripping the `whsec_` prefix and base64 decoding, compared in constant time. Two payload dialects exist: the new one mirrors the `id` / `status` / `outputs` shape, the legacy one uses `task_id` / `task_status` / `task_status_msg` / `task_info` / `task_result`. Retry behaviour is not documented (UNVERIFIED).

## 5. Streaming

None. There is no streaming, no partial frames and no progressive delivery on any Kling video endpoint. The in-flight signals are the polled status and the callback at `processing`. There is no realtime or WebRTC video product. Confirmed by absence across the [capability map](https://kling.ai/document-api/guides/capability-map/video.md) and the full endpoint list in [llms.txt](https://kling.ai/document-api/llms.txt); the closest thing is the Avatar product, which is still a batch task.

## 6. Audio

Yes, native, and it is a first class toggle: `settings.audio` with `native` (model generates audio), `original` (keep the input video's audio, omni and motion control only) or `off` (default). Kling 3.0, 3.0 Omni, 3.0 Turbo and 2.6 all support native audio; 2.5 Turbo does not. Audio costs extra, see pricing.

Separate audio products: Lip Sync (`/v1/videos/lip-sync`) with text-driven or audio-driven modes plus a face detection helper, Avatar with its own TTS endpoint, Text to Audio and Video to Audio generation endpoints.

## 7. Output

Container and codec are not stated in the docs (UNVERIFIED, mp4/H.264 in practice). Resolution 720p, 1080p or 4k per `settings.resolution`. **Watermark is opt-in and off by default**: `options.watermark_info.enabled`, default `false`. This is the opposite of most vendors. Retention 30 days, then cleared.

## 8. Pricing, limits

Priced in "Units", and the docs give the USD equivalent inline at roughly **1 Unit = $0.14**. ([pricing](https://kling.ai/document-api/pricing/base/video.md))

| Model     | Config                | 720p                 | 1080p                    | 4K            |
| --------- | --------------------- | -------------------- | ------------------------ | ------------- |
| 3.0 Turbo |                       | 0.8 U / $0.112 per s | 1.0 U / $0.14 per s      | n/a           |
| 3.0       | no audio              | 0.6 U / $0.084       | 0.8 U / $0.112           | 3.0 U / $0.42 |
| 3.0       | native audio          | 0.9 U / $0.126       | 1.2 U / $0.168           | 3.0 U / $0.42 |
| 3.0       | motion control        | 0.9 U / $0.126       | 1.2 U / $0.168           | n/a           |
| 3.0 Omni  | no video in, no audio | 0.6 U / $0.084       | 0.8 U / $0.112           | 3.0 U / $0.42 |
| 3.0 Omni  | no video in, audio    | 0.8 U / $0.112       | 1.0 U / $0.14            | 3.0 U / $0.42 |
| 3.0 Omni  | with video in         | 0.9 U / $0.126       | 1.2 U / $0.168           | 3.0 U / $0.42 |
| O1        | no video in           | 0.6 U / $0.084       | 0.8 U / $0.112           | n/a           |
| O1        | with video in         | 0.9 U / $0.126       | 1.2 U / $0.168           | n/a           |
| 2.6       | basic                 | 0.3 U / $0.042       | 0.5 U / $0.07            | n/a           |
| 2.6       | native audio          |                      | 1.0-1.2 U / $0.14-$0.168 | n/a           |
| 2.6       | motion control        | 0.5 U / $0.07        | 0.8 U / $0.112           | n/a           |
| 2.5 Turbo |                       | 0.3 U / $0.042       | 0.5 U / $0.07            | n/a           |

Ancillary: Avatar 0.4-0.8 U/s ($0.056-$0.112), TTS 0.05 U/call, Lip Sync 0.5 U per 5s, Audio Generation 0.25 U/call, Image Recognition 0.1 U/call.

Limits ([concurrency rules](https://kling.ai/document-api/api/get-started/concurrency-rules.md)): **there is no QPS or rate limit at all**, only concurrency. Concurrency is the max simultaneous generation tasks, set by your resource package, and the effective quota is the highest concurrency among all active packages of the same type (not the sum). A video task consumes 1 slot; an image task consumes `n` slots. A slot is held from `submitted` through completion including failure, then released immediately. Polling does not consume concurrency. Over limit returns code 1303; the docs recommend exponential backoff starting at 1 second or more.

No latency claims are published for any tier, including Turbo.

## 9. Minimal JSON

Create:

```http
POST https://api-singapore.klingai.com/image-to-video/kling-3.0
Authorization: Bearer <api key>
Content-Type: application/json
```

```json
{
  "contents": [
    { "type": "prompt", "text": "a hot air balloon drifts over a valley at sunrise" },
    { "type": "first_frame", "url": "https://example.com/first.jpg" },
    { "type": "last_frame", "url": "https://example.com/last.jpg" }
  ],
  "settings": {
    "resolution": "1080p",
    "duration": 5,
    "audio": "native",
    "multi_shot": true
  },
  "options": {
    "callback_url": "https://example.com/hooks/kling",
    "external_task_id": "my-job-001",
    "watermark_info": { "enabled": false }
  }
}
```

Pending poll (`GET /tasks?task_ids=...`):

```json
{
  "code": 0,
  "message": "SUCCEED",
  "request_id": "...",
  "data": {
    "id": "task_id",
    "status": "processing",
    "create_time": 1781080778802,
    "update_time": 1781080794151,
    "external_id": "my-job-001"
  }
}
```

Succeeded poll:

```json
{
  "code": 0,
  "message": "SUCCEED",
  "request_id": "...",
  "data": {
    "id": "task_id",
    "status": "succeeded",
    "outputs": [{ "type": "video", "url": "https://...mp4", "duration": "5" }],
    "billing": [{ "charge_type": "unit", "amount": "6.0" }]
  }
}
```

## 10. Aggregators

- **fal: present.** `fal-ai/kling-video/v3/pro/image-to-video` and `fal-ai/kling-video/v3/standard/text-to-video`. fal reshapes the API back into a flat body with `prompt`, `duration`, `aspect_ratio`, `resolution` and exposes only pro/standard tiers, so the `contents` discriminated array, `element`, `base_video`, `feature_video`, motion control and `watermark_info` are not reachable through fal. Also note fal's `v3/standard` and `v3/pro` map to a std/pro axis that no longer exists natively.
- **Replicate: present**, including Kling 3.0 Omni. Same flattening caveat, UNVERIFIED in detail.
- Also resold by Alibaba Cloud Model Studio, Picsart, Magnific, Segmind, kie.ai and others, all with their own `model_name` strings such as `kling-v3-0-turbo`. None of those strings are valid against `api-singapore.klingai.com`.

---

# LUMA

**The API moved.** `docs.lumalabs.ai` and `api.lumalabs.ai/dream-machine/v1` are the legacy Dream Machine API and only ever exposed Ray 2 and Ray 2 Flash. Luma's own AI-facing page says plainly: "Do not use 'Dream Machine', it is an older deprecated model replaced by Ray", and that Ray2 and earlier are deprecated. ([llm-info](https://lumalabs.ai/llm-info)) Ray3.2 is only on the **Luma Agents API**.

Base URL `https://agents.lumalabs.ai/v1`. Auth: Bearer token in `Authorization`, key conventionally in `LUMA_AGENTS_API_KEY`. ([docs](https://docs.agents.lumalabs.ai/))

## 1. Models

| Model id    | Supports                               | Use for                                           |
| ----------- | -------------------------------------- | ------------------------------------------------- |
| `ray-3.2`   | `video`, `video_edit`, `video_reframe` | text-to-video, image-to-video, editing, reframing |
| `uni-1`     | `image`, `image_edit`                  | default image                                     |
| `uni-1-max` | `image`, `image_edit`                  | higher quality image                              |

([models](https://docs.agents.lumalabs.ai/guides/model)) One video model, no fast tier, no flash variant. Deprecated: everything before Ray3.2, plus Photon as a separate product. Simplest lineup of the three vendors by a wide margin.

## 2. Endpoints

Two endpoints, total.

| Purpose         | Endpoint                              |
| --------------- | ------------------------------------- |
| create anything | `POST /v1/generations`                |
| poll            | `GET /v1/generations/{generation_id}` |

Everything is discriminated by a `type` field on the body: `video`, `video_edit`, `video_reframe`, `image`, `image_edit`. Text-to-video and image-to-video are the same `type: "video"`, differing only by whether `video.start_frame` / `keyframes` are present. Extend is `type: "video"` with `start_frame.generation_id` or `end_frame.generation_id` pointing at a prior generation. Reframe is `type: "video_reframe"`. Video-to-video is `type: "video_edit"`. There is no upscale.

No cancel or delete endpoint is documented (UNVERIFIED). `callback_url` is listed on the docs index as a request parameter but does not appear in the video generation field table, so webhook support for video is **UNVERIFIED**.

## 3. Request parameters

Top level: `model` (`"ray-3.2"`), `type`, `prompt` (1 to 6,000 chars), `aspect_ratio` (`9:16`, `3:4`, `1:1`, `4:3`, `16:9`, `21:9`; omit for auto). All output controls live under a nested `video` object. ([video generation](https://docs.agents.lumalabs.ai/guides/videos/generation))

| `video` field      | Values                          | Notes                                                                                           |
| ------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `resolution`       | `360p`, `540p`, `720p`, `1080p` | default `720p`; 360p/540p incompatible with HDR                                                 |
| `duration`         | `"5s"`, `"10s"`                 | **string, not a number**; default `5s`; `10s` incompatible with HDR, `start_frame`, `end_frame` |
| `loop`             | boolean                         | create only; rejected with `10s`, `hdr`, `end_frame` or `keyframes`                             |
| `hdr`              | boolean                         | requires 720p or 1080p                                                                          |
| `exr_export`       | boolean                         | requires `hdr: true`                                                                            |
| `start_frame`      | ImageRef                        | first frame anchor, or extend from a prior generation                                           |
| `end_frame`        | ImageRef                        | last frame anchor                                                                               |
| `keyframes`        | ImageRef[], 1 to 64             | mutually exclusive with `start_frame`, `end_frame`, `loop`                                      |
| `keyframe_indexes` | number[]                        | parallel to `keyframes`; 0-120 for `5s`, 0-240 for `10s`, i.e. **frame numbers at 24fps**       |

ImageRef is a union of three shapes: `{ "url": "..." }`, `{ "data": "<base64>", "media_type": "image/png" }`, or `{ "generation_id": "<uuid>" }`.

Multi-keyframe is Luma's distinguishing feature: up to 64 anchors with explicit frame indexes inside one clip. (Luma's launch post says 16 keyframes; the API docs say 1 to 64. The 64 figure is the primary source, the 16 figure is marketing. Treat 16 as stale.)

Absent: `seed`, `negative_prompt`, `cfg_scale`, camera control, content moderation settings, `fps`, audio.

## 4. Task lifecycle

`state` is the status field. Confirmed values: `completed`, `failed`. The in-flight state strings are **UNVERIFIED** (the legacy Dream Machine API used `queued` and `dreaming`; the Agents API render did not enumerate them). Failure carries `failure_reason` and `failure_code`. No progress fraction documented.

Output is `output: [{ "type": "video", "url": "..." }]`. The example URL is an S3 presigned link carrying `X-Amz-Expires=3600`, so **roughly 1 hour**, the shortest expiry of the three vendors. Retention of the underlying asset is UNVERIFIED.

Response headers include `X-Request-Id`, `X-API-Version`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. Luma is the only one of the three that returns standard rate limit headers.

## 5. Streaming

None. Create then poll, nothing arrives before `completed`. No realtime product, no WebRTC, no partial frames. Confirmed by the endpoint list: the entire API is `POST /v1/generations` plus `GET /v1/generations/{id}`. ([docs index](https://docs.agents.lumalabs.ai/))

## 6. Audio

**No audio at all.** The models page states Ray-3.2 does not produce audio, and there is no audio field anywhere in the video request. No lip sync product, no audio-to-video product, no TTS. Luma is silent-video-only, which is now unusual.

## 7. Output

mp4 by default (UNVERIFIED as to codec). Native HDR via `hdr: true`, and 16-bit EXR export via `exr_export: true` for color pipelines, which is Luma's professional differentiator alongside Runway's ProRes/EXR options. Resolutions 360p through 1080p; no 4K. Watermark policy UNVERIFIED (not stated). Output URL good for about an hour.

## 8. Pricing, limits

Priced directly in USD, no credit layer. ([pricing](https://docs.agents.lumalabs.ai/guides/pricing/))

| Request type           | Range                       | 540p  | 720p  | 1080p |
| ---------------------- | --------------------------- | ----- | ----- | ----- |
| generate, 5s           | SDR                         | $0.15 | $0.30 | $1.20 |
| generate, 10s          | SDR                         | $0.45 | $0.90 | $3.60 |
| generate, 5s           | HDR                         | n/a   | $0.60 | $2.40 |
| generate, 5s           | HDR + EXR                   | n/a   | $0.90 | $3.60 |
| single-keyframe extend | SDR, billed as one 5s block | $0.15 | $0.30 | $1.20 |
| reframe, per second    | SDR only                    | $0.06 | $0.12 | $0.36 |
| edit, 5s               | SDR                         | $0.72 | $1.08 | $2.16 |
| edit, 10s              | SDR                         | $1.44 | $2.16 | $4.32 |
| edit, 5s               | HDR                         | $1.44 | $2.16 | $4.32 |
| edit, 5s               | HDR + EXR                   | $2.16 | $3.24 | $6.48 |

Two notable shapes. First, pricing is **per video block, not per second**, except reframe. Second, the 10s SDR price is 3x the 5s price, not 2x, so duration is superlinear. 1080p 5s SDR works out to $0.24/s, which is double Runway `gen4.5` and well above Kling 3.0 1080p.

Billing plans: "Build" (usage based, no commitment) and "Scale" (dedicated capacity with throughput and latency SLAs). The SLA numbers are UNVERIFIED. Rate limits are exposed per response via headers rather than published as a tier table.

## 9. Minimal JSON

Create:

```http
POST https://agents.lumalabs.ai/v1/generations
Authorization: Bearer <key>
Content-Type: application/json
```

```json
{
  "model": "ray-3.2",
  "type": "video",
  "prompt": "A hot-air balloon drifts across a valley as the sun rises",
  "aspect_ratio": "16:9",
  "video": {
    "resolution": "720p",
    "duration": "5s",
    "keyframes": [
      { "url": "https://example.com/launch.jpg" },
      { "url": "https://example.com/midflight.jpg" },
      { "url": "https://example.com/sunrise.jpg" }
    ],
    "keyframe_indexes": [0, 60, 120]
  }
}
```

Pending poll (`GET /v1/generations/{id}`), state string UNVERIFIED:

```json
{
  "id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "type": "video",
  "state": "pending",
  "model": "ray-3.2",
  "created_at": "2026-09-19T12:00:00Z",
  "output": null
}
```

Succeeded poll:

```json
{
  "id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "type": "video",
  "state": "completed",
  "model": "ray-3.2",
  "created_at": "2026-09-19T12:00:00Z",
  "output": [{ "type": "video", "url": "https://storage.../output.mp4?X-Amz-Expires=3600&..." }],
  "failure_reason": null,
  "failure_code": null
}
```

## 10. Aggregators

- **fal:** no Luma Ray entries appeared in fal's current video catalogue. Absence is UNVERIFIED (I checked a category listing, not an exhaustive search).
- **Replicate:** Luma models are present on Replicate's text-to-video collection. Whether `ray-3.2` specifically with `keyframes` / `keyframe_indexes` / `hdr` / `exr_export` is exposed is UNVERIFIED; the multi-keyframe surface is exactly the kind of thing aggregators drop.

---

## Cross-vendor implications for a `VideoGenerator` capability

**Genuinely uniform** (safe for the common request): prompt text, a start image, a duration, an aspect or ratio, a resolution, and an async task id. That is all.

**Looks uniform but is not:**

- _Ratio encoding._ Runway uses pixel pairs (`"1280:720"`) for its own models but plain ratios (`"16:9"`) for some hosted ones. Kling and Luma use plain ratios. Do not normalise; keep it provider-typed.
- _Duration type._ Runway integer seconds, Kling integer seconds, Luma a string enum (`"5s"`, `"10s"`). Luma cannot express 7 seconds at all.
- _First and last frame._ Three different encodings: Runway `promptImage[].position`, Kling `contents[].type`, Luma `video.start_frame` / `end_frame` / `keyframes` + `keyframe_indexes`. Only Luma has real multi-keyframe.
- _Resolution._ Runway derives it from `ratio`. Kling and Luma have an explicit `resolution` field with different enums (Kling has 4k, Luma has 360p, neither overlaps fully).

**Vendor-only, do not promote:** Runway `contentModeration.publicFigureThreshold`, Runway pro/HDR output format enum, Runway `seed`; Kling `multi_shot` and the shot prompt syntax, `watermark_info`, `element` ids, `character_orientation`; Luma `loop`, `hdr`, `exr_export`, `keyframe_indexes`.

**Audio:** Kling is the only one of the three with a real native audio toggle (`settings.audio`: `native` / `original` / `off`). Runway's own models are silent and audio is a separate endpoint family, except for hosted `veo3.1`. Luma has no audio whatsoever. So "generate audio" is not a uniform boolean; at best it is an `Option<AudioMode>` that two of three providers reject.

**Streaming:** all three are create-then-poll with nothing before completion. Progressive delivery does not exist for batch video anywhere in this set. The only realtime surface is Runway Characters, which is a different protocol entirely (WebRTC over LiveKit, 5 minute sessions, conversational avatar) and should not be modelled as a `VideoGenerator` at all.

**Callbacks:** only Kling has webhooks, and they are properly signed (Svix-style HMAC-SHA256). Runway has none. Luma's is unconfirmed. A polling-first design is mandatory, with Kling callbacks as an optional accelerator.

**Result URL lifetime:** Luma about 1 hour, Runway 24 to 48 hours, Kling assets retained 30 days. Any recipe must download promptly; a `VideoGenerator` that hands back a URL and nothing else is a footgun on Luma.

**Surprises worth flagging:**

1. Runway is now itself an aggregator, hosting Veo, Seedance, Wan, Hailuo, Grok and Gemini behind `/v1/image_to_video`, with a Model Router product on top. Integrating Runway buys a lot more than Gen-4.5.
2. Runway's `THROTTLED` status means over-concurrency is a task state, not an HTTP error. Backoff logic has to read the task, not just the response code.
3. Kling versions by URL path, not by a `model_name` field. Every new Kling model is a new endpoint. A provider package must treat the model id as part of the route.
4. Kling has no rate limit at all, only concurrency slots, and the quota is the max of your packages rather than the sum.
5. Kling watermarks are off by default and opt-in.
6. Luma's 10s price is 3x the 5s price, not 2x.
7. Kling 3.0 Turbo costs more per second than Kling 3.0 at the same resolution. It is a latency tier, not a savings tier.
8. Every aggregator model id for Kling (`kling-v3-0-turbo`, `kling-v3-omni`, `fal-ai/kling-video/v3/pro/...`) is a wrapper invention. None are valid natively.

---

## Sources

- Runway, AI context: https://docs.dev.runwayml.com/ai-context.md
- Runway, models guide: https://docs.dev.runwayml.com/guides/models.md
- Runway, pricing: https://docs.dev.runwayml.com/guides/pricing.md
- Runway, core API: https://docs.dev.runwayml.com/_llms-txt/core-api.txt
- Runway, characters: https://docs.dev.runwayml.com/_llms-txt/characters.txt
- Runway, API reference: https://docs.dev.runwayml.com/api.md
- Runway, usage tiers: https://docs.dev.runwayml.com/usage/tiers/
- Runway, outputs: https://docs.dev.runwayml.com/assets/outputs/
- Runway, OpenAPI (not fetched, recommended next): https://docs.dev.runwayml.com/openapi.json
- Runway on Replicate: https://replicate.com/runwayml/gen-4.5/readme
- Kling, doc index: https://kling.ai/document-api/llms.txt
- Kling, authentication: https://kling.ai/document-api/api/get-started/authentication.md
- Kling, concurrency rules: https://kling.ai/document-api/api/get-started/concurrency-rules.md
- Kling, callbacks: https://kling.ai/document-api/api/get-started/callbacks.md
- Kling, 3.0 text to video: https://kling.ai/document-api/api/video/3-0-omni/text-to-video.md
- Kling, 3.0 image to video: https://kling.ai/document-api/api/video/3-0-omni/image-to-video.md
- Kling, 3.0 Omni video: https://kling.ai/document-api/api/video/3-0-omni/video-omni.md
- Kling, motion control: https://kling.ai/document-api/api/video/3-0-omni/motion-control.md
- Kling, 3.0 Turbo text to video: https://kling.ai/document-api/api/video/3-0-turbo/text-to-video.md
- Kling, capability map: https://kling.ai/document-api/guides/capability-map/video.md
- Kling, video pricing: https://kling.ai/document-api/pricing/base/video.md
- Kling, API updates: https://kling.ai/document-api/updates/api.md
- Kling on fal: https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video/api
- Luma, official AI info: https://lumalabs.ai/llm-info
- Luma Agents, docs index: https://docs.agents.lumalabs.ai/
- Luma Agents, models: https://docs.agents.lumalabs.ai/guides/model
- Luma Agents, video generation: https://docs.agents.lumalabs.ai/guides/videos/generation
- Luma Agents, pricing: https://docs.agents.lumalabs.ai/guides/pricing/
- Luma, Ray3.2 announcement: https://lumalabs.ai/news/introducing-ray-3-2
- Luma, legacy Dream Machine docs: https://docs.lumalabs.ai/docs/api
- fal, video model catalogue: https://fal.ai/models?categories=text-to-video
