# Subagent report: video generation, aggregators (fal, Pruna, Replicate, gateways) (2026-09-19)

Raw research report. Summarised in `../video-generation.md`.

All endpoint ids are quoted exactly as the fal model page URL spells them (`https://fal.ai/models/{id}`). Anything not confirmed on a primary page is marked UNVERIFIED.

## 1. fal.ai

### 1.1 Video catalogue (September 2026)

The fal explore page (`https://fal.ai/models?categories=text-to-video`) currently front-loads a newer generation than the brief lists: MiniMax H3 / H3 Max, Seedance 2.0 / 2.5, Kling v3 / O3, Wan 3.0 (Prime), LTX-2.3 / 2.5, Grok Imagine 1.5, FLUX 3 video. The older families the brief names are still live but no longer featured. Note the namespace split: fal's own wrappers live under `fal-ai/…`, first-party partner deployments live under the vendor namespace (`minimax/…`, `bytedance/…`, `alibaba/…`, `lightricks/…`, `xai/…`, `decart/…`, `veed/…`, `topaz/…`, `blackforestlabs/…`).

Sora 2 on fal is deprecated: the `fal-ai/sora-2/text-to-video` page carries "This endpoint is deprecated", "This model is no longer supported", "This endpoint will be shut down on September 24, 2026" (https://fal.ai/models/fal-ai/sora-2/text-to-video).

#### Text-to-video

| Family | Endpoint id | Fast / turbo variant | Source |
| --- | --- | --- | --- |
| Veo 3.1 | `fal-ai/veo3.1` | `fal-ai/veo3.1/fast` | https://fal.ai/models/fal-ai/veo3.1 |
| Veo 3.1 Lite | `fal-ai/veo3.1/lite/first-last-frame-to-video` (i2v only seen; a lite t2v id is UNVERIFIED) | | https://fal.ai/models/fal-ai/veo3.1/lite/first-last-frame-to-video |
| Sora 2 (deprecated) | `fal-ai/sora-2/text-to-video`, `fal-ai/sora-2/text-to-video/pro` | | https://fal.ai/models/fal-ai/sora-2/text-to-video/pro |
| Kling v3 | `fal-ai/kling-video/v3/standard/text-to-video`, `fal-ai/kling-video/v3/pro/text-to-video`, `fal-ai/kling-video/v3/4k/text-to-video` | `fal-ai/kling-video/v3/turbo/pro/text-to-video` | https://fal.ai/models/fal-ai/kling-video/v3/4k/text-to-video, https://fal.ai/video |
| Kling O3 | `fal-ai/kling-video/o3/4k/text-to-video` | | https://fal.ai/models/fal-ai/kling-video/o3/4k/text-to-video |
| Kling 2.5 / 2.6 | `fal-ai/kling-video/v2.5-turbo/pro/text-to-video` (2.6 t2v id UNVERIFIED) | (2.5 is itself "turbo") | https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/text-to-video |
| MiniMax H3 / H3 Max | `minimax/h3/text-to-video`, `minimax/h3-max/text-to-video` | `minimax/h3-max-turbo/text-to-video` | https://fal.ai/models/minimax/h3-max/text-to-video |
| MiniMax Hailuo 2.3 / 02 | `fal-ai/minimax/hailuo-02/standard/text-to-video`, `fal-ai/minimax/hailuo-02/pro/text-to-video` (2.3 t2v ids UNVERIFIED, only i2v pages found) | `fal-ai/minimax/hailuo-2.3-fast/…` (i2v) | https://fal.ai/models/fal-ai/minimax/hailuo-02/pro/text-to-video |
| Seedance 2.5 | `bytedance/seedance-2.5/text-to-video`, `bytedance/seedance-2.5/us/text-to-video` (US-hosted) | none listed | https://fal.ai/models/bytedance/seedance-2.5/text-to-video |
| Seedance 2.0 | `bytedance/seedance-2.0/text-to-video` | `bytedance/seedance-2.0/fast/text-to-video`, `bytedance/seedance-2.0/mini/text-to-video` | https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video |
| Seedance 1.x | `fal-ai/bytedance/seedance/v1/pro/text-to-video`, `fal-ai/bytedance/seedance/v1/lite/text-to-video`, `fal-ai/bytedance/seedance/v1.5/pro/text-to-video` | `fal-ai/bytedance/seedance/v1/pro/fast/text-to-video` | https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/fast/text-to-video/api |
| Wan 3.0 | `alibaba/wan-3.0/text-to-video`, `alibaba/wan-3.0-prime/text-to-video` | | https://fal.ai/models/alibaba/wan-3.0-prime/text-to-video |
| Wan 2.x | `wan/v2.6/text-to-video`, `fal-ai/wan-25-preview/text-to-video`, `fal-ai/wan/v2.2-a14b/text-to-video`, `fal-ai/wan/v2.2-5b/text-to-video` | | https://fal.ai/models/wan/v2.6/text-to-video |
| LTX-2.5 | `lightricks/ltx-2.5/text-to-video/pro` | `lightricks/ltx-2.5/text-to-video/fast` | https://fal.ai/ltx-2.5 |
| LTX-2.3 | `fal-ai/ltx-2.3/text-to-video` | `fal-ai/ltx-2.3/text-to-video/fast` | https://fal.ai/ltx-2.3 |
| LTX-2 | `fal-ai/ltx-2/text-to-video`, `fal-ai/ltx-2-19b/text-to-video` | `fal-ai/ltx-2/text-to-video/fast`, `fal-ai/ltx-2-19b/distilled/text-to-video/lora` | https://fal.ai/models/fal-ai/ltx-2-19b/text-to-video/api |
| Hunyuan | `fal-ai/hunyuan-video`, `fal-ai/hunyuan-video-v1.5/text-to-video` | | https://fal.ai/models/fal-ai/hunyuan-video-v1.5/text-to-video |
| Luma Ray 2 | `fal-ai/luma-dream-machine/ray-2` | `fal-ai/luma-dream-machine/ray-2-flash` | https://fal.ai/models/fal-ai/luma-dream-machine/ray-2/api |
| Pika | `fal-ai/pika/v2.2/text-to-video`, `fal-ai/pika/v2.1/text-to-video` | | https://fal.ai/models/fal-ai/pika/v2.2/text-to-video |
| Vidu | `fal-ai/vidu/q3/text-to-video`, `fal-ai/vidu/q2/text-to-video` | `fal-ai/vidu/q3/text-to-video/turbo` | https://fal.ai/models/fal-ai/vidu/q3/text-to-video/turbo |
| Grok Imagine | `xai/grok-imagine-video/text-to-video`, `xai/grok-imagine-video/v1.5/text-to-video` | | https://fal.ai/models/xai/grok-imagine-video/v1.5/text-to-video |
| PixVerse | `fal-ai/pixverse/c1/text-to-video` | | https://fal.ai/video |
| Runway | not on fal (no `fal.ai/models` results for gen-4 / gen-4.5 / aleph; Runway is on Replicate as `runwayml/gen-4.5`) | | |
| Luma Ray 3 | not on fal (only Ray 2 pages found) | | |

#### Image-to-video (first frame, optional last frame)

| Family | Endpoint id | Fast variant | Source |
| --- | --- | --- | --- |
| Veo 3.1 | `fal-ai/veo3.1/image-to-video`, `fal-ai/veo3.1/first-last-frame-to-video`, `fal-ai/veo3.1/lite/first-last-frame-to-video` | `fal-ai/veo3.1/fast/image-to-video`, `fal-ai/veo3.1/fast/first-last-frame-to-video` | https://fal.ai/models/fal-ai/veo3.1 |
| Sora 2 (deprecated) | `fal-ai/sora-2/image-to-video/pro` | | https://fal.ai/models/fal-ai/sora-2/image-to-video/pro |
| Kling v3 | `fal-ai/kling-video/v3/standard/image-to-video`, `fal-ai/kling-video/v3/pro/image-to-video`, `fal-ai/kling-video/v3/pro/image-to-video/4k` | `fal-ai/kling-video/v3/turbo/pro/image-to-video`, `fal-ai/kling-video/v3/turbo/standard/image-to-video` | https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video |
| Kling O3 | `fal-ai/kling-video/o3/standard/image-to-video` | | https://fal.ai/models/fal-ai/kling-video/o3/standard/image-to-video |
| Kling 2.5 / 2.6 | `fal-ai/kling-video/v2.5-turbo/pro/image-to-video`, `fal-ai/kling-video/v2.6/pro/image-to-video` | | https://fal.ai/models/fal-ai/kling-video/v2.6/pro/image-to-video |
| MiniMax H3 | `minimax/h3/image-to-video`, `minimax/h3-max/image-to-video` | `minimax/h3-max-turbo/image-to-video` | https://fal.ai/models/minimax/h3-max/image-to-video/api |
| Hailuo 2.3 / 02 | `fal-ai/minimax/hailuo-2.3/standard/image-to-video`, `fal-ai/minimax/hailuo-2.3/pro/image-to-video`, `fal-ai/minimax/hailuo-02/standard/image-to-video`, `fal-ai/minimax/hailuo-02/pro/image-to-video` | `fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video`, `fal-ai/minimax/hailuo-2.3-fast/pro/image-to-video` | https://fal.ai/models/fal-ai/minimax/hailuo-2.3-fast/pro/image-to-video/api |
| Seedance 2.5 / 2.0 | `bytedance/seedance-2.5/image-to-video`, `bytedance/seedance-2.5/us/image-to-video`, `bytedance/seedance-2.0/image-to-video` | `bytedance/seedance-2.0/fast/image-to-video`, `bytedance/seedance-2.0/mini/image-to-video` | https://fal.ai/models/bytedance/seedance-2.5/image-to-video |
| Seedance 1.x | `fal-ai/bytedance/seedance/v1/pro/image-to-video`, `fal-ai/bytedance/seedance/v1/lite/image-to-video`, `fal-ai/bytedance/seedance/v1.5/pro/image-to-video` | | https://fal.ai/models/fal-ai/bytedance/seedance/v1/pro/image-to-video |
| Wan 3.0 / 2.x | `alibaba/wan-3.0-prime/image-to-video`, `alibaba/wan-3.0/image-to-video`, `wan/v2.6/image-to-video`, `fal-ai/wan/v2.2-a14b/image-to-video` | | https://fal.ai/models/alibaba/wan-3.0-prime/image-to-video |
| LTX-2.5 / 2.3 / 2 | `lightricks/ltx-2.5/image-to-video/pro`, `fal-ai/ltx-2.3/image-to-video`, `fal-ai/ltx-2/image-to-video`, `fal-ai/ltx-2-19b/image-to-video`, `fal-ai/ltx-video-13b-distilled/image-to-video` | `lightricks/ltx-2.5/image-to-video/fast`, `fal-ai/ltx-2.3/image-to-video/fast`, `fal-ai/ltx-2/image-to-video/fast` | https://fal.ai/models/fal-ai/ltx-2/image-to-video/fast |
| Hunyuan 1.5 | `fal-ai/hunyuan-video-v1.5/image-to-video`, `fal-ai/hunyuan-custom` | | https://fal.ai/models/fal-ai/hunyuan-video-v1.5/image-to-video |
| Luma Ray 2 | `fal-ai/luma-dream-machine/ray-2/image-to-video`, `fal-ai/luma-dream-machine/ray-2-flash/image-to-video` | | https://fal.ai/models/fal-ai/luma-dream-machine/ray-2-flash/image-to-video/api |
| Pika | `fal-ai/pika/v2.2/image-to-video`, `fal-ai/pika/v2.2/pikaframes` (keyframes), `fal-ai/pika/v2.2/pikascenes`, `fal-ai/pika/v2.1/image-to-video` | | https://fal.ai/models/fal-ai/pika/v2.2/pikaframes/api |
| Vidu | `fal-ai/vidu/q3/image-to-video`, `fal-ai/vidu/q2/image-to-video/pro` | `fal-ai/vidu/q3/image-to-video/turbo` | https://fal.ai/models/fal-ai/vidu/q3/image-to-video/turbo/api |
| Grok Imagine | `xai/grok-imagine-video/image-to-video`, `xai/grok-imagine-video/v1.5/image-to-video` | | https://fal.ai/models/xai/grok-imagine-video/v1.5/image-to-video/api |
| FLUX 3 | `blackforestlabs/flux-3/image-to-video`, `blackforestlabs/flux-3/keyframes-to-video` | | https://fal.ai/video |
| Decart | `fal-ai/decart/lucy-5b/image-to-video` | | https://fal.ai/explore/decart |
| PixVerse | `fal-ai/pixverse/c1/image-to-video` | | https://fal.ai/video |

#### Video-to-video, extend, reference-to-video, edit

| Family | Endpoint id | Source |
| --- | --- | --- |
| Veo 3.1 | `fal-ai/veo3.1/reference-to-video`, `fal-ai/veo3.1/extend-video`, `fal-ai/veo3.1/fast/extend-video` (extend chains up to 7 s per step, 20 steps) | https://fal.ai/models/fal-ai/veo3.1/extend-video |
| Sora 2 (deprecated) | `fal-ai/sora-2/video-to-video/remix` (only remixes Sora-generated videos) | https://fal.ai/models/fal-ai/sora-2/video-to-video/remix |
| Kling O3 | `fal-ai/kling-video/o3/standard/video-to-video/reference` | https://fal.ai/models/fal-ai/kling-video/o3/standard/video-to-video/reference |
| MiniMax H3 | `minimax/h3/reference-to-video`, `minimax/h3-max/reference-to-video`, `minimax/h3-max/camera-controls` (multi-angle) | https://fal.ai/models?categories=video-to-video |
| Seedance | `bytedance/seedance-2.5/reference-to-video` (up to 50 multimodal references), `bytedance/seedance-2.5/us/reference-to-video`, `bytedance/seedance-2.0/reference-to-video`, `bytedance/seedance-2.0/fast/reference-to-video`, `fal-ai/bytedance/seedance/v1/lite/reference-to-video` | https://fal.ai/models/bytedance/seedance-2.0/fast/reference-to-video |
| LTX-2.3 / 2 | `fal-ai/ltx-2.3/extend-video`, `fal-ai/ltx-2.3/retake-video`, `fal-ai/ltx-2.3/audio-to-video`, `fal-ai/ltx-2/extend-video`, `fal-ai/ltx-2-19b/video-to-video`, `fal-ai/ltx-2-19b/distilled/video-to-video`, `fal-ai/ltx-2-19b/audio-to-video`, `lightricks/ltx-2.5/audio-to-video/pro`, `lightricks/ltx-2.5/audio-to-video/fast` | https://fal.ai/models/fal-ai/ltx-2.3/extend-video/api |
| Hunyuan | `fal-ai/hunyuan-video/video-to-video`, `fal-ai/hunyuan-video-lora/video-to-video` | https://fal.ai/models/fal-ai/hunyuan-video/video-to-video/api |
| Luma Ray 2 | `fal-ai/luma-dream-machine/ray-2/modify`, `fal-ai/luma-dream-machine/ray-2/reframe`, `fal-ai/luma-dream-machine/ray-2-flash/reframe` | https://fal.ai/models/fal-ai/luma-dream-machine/ray-2/modify/api |
| Vidu | `fal-ai/vidu/q2/video-extension/pro` | https://fal.ai/models/fal-ai/vidu/q2/video-extension/pro |
| Grok Imagine | `xai/grok-imagine-video/extend-video`, `xai/grok-imagine-video/edit-video`, `xai/grok-imagine-video/v1.5/reference-to-video` | https://fal.ai/models?categories=video-to-video |
| Krea | `fal-ai/krea-wan-14b/video-to-video` (queue, not realtime; `prompt`, `video_url`, `strength`) | https://fal.ai/models/fal-ai/krea-wan-14b/video-to-video/api |
| Decart | `decart/lucy-restyle` ($0.01/s), `decart/lucy-edit/pro` ($0.10/s) | https://fal.ai/explore/decart |
| Mirage | `mirage-api/avatar-x/reference-to-video` | https://fal.ai/video |

#### Lipsync / talking head

| Endpoint id | Notes | Source |
| --- | --- | --- |
| `fal-ai/sync-lipsync/v2` | `video_url`, `audio_url`, `model` (`lipsync-2` default, `lipsync-2-pro`), `sync_mode` here means duration mismatch handling (`cut_off`, `loop`, `bounce`, `silence`, `remap`), not the platform data-URI flag | https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/sync-lipsync/v2 |
| `fal-ai/sync-lipsync` | Lipsync 1.9 | https://fal.ai/models/fal-ai/sync-lipsync/api |
| `veed/lipsync`, `veed/lipsync/v2`, `veed/fabric-1.0` | | https://fal.ai/models/veed/lipsync/v2 |
| `fal-ai/kling-video/lipsync/audio-to-video` (a `lipsync/text-to-video` sibling is implied by the page title; UNVERIFIED), `fal-ai/kling-video/ai-avatar/v2/standard`, `fal-ai/kling-video/ai-avatar/v2/pro` | | https://fal.ai/models/fal-ai/kling-video/lipsync/audio-to-video/api |
| `minimax/h3-max/lip-sync/image-to-video` | image + audio | https://fal.ai/models?categories=text-to-video |
| `fal-ai/infinitalk`, `fal-ai/infinitalk/single-text` | | https://fal.ai/models/fal-ai/infinitalk/api |
| `fal-ai/bytedance/omnihuman/v1.5` | | https://fal.ai/models/fal-ai/bytedance/omnihuman/v1.5 |
| `fal-ai/latentsync` | | https://fal.ai/models/fal-ai/latentsync/api |

#### Upscale / enhance

| Endpoint id | Notes | Source |
| --- | --- | --- |
| `fal-ai/topaz/upscale/video` | `video_url`, `upscale_factor` 1-4 (default 2), `target_fps` 16-60, `model` (Proteus default, Artemis/Gaia/Nyx/Starlight), `H264_output` | https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/topaz/upscale/video |
| `topaz/upscale/video/generative`, `topaz/deblur/video` | Starlight generative | https://fal.ai/models/topaz/upscale/video/generative/api |
| `fal-ai/seedvr/upscale/video` | SeedVR2 | https://fal.ai/models/fal-ai/seedvr/upscale/video/api |
| `fal-ai/flashvsr/upscale/video` | | https://fal.ai/models/fal-ai/flashvsr/upscale/video/api |
| `fal-ai/film/video` | frame interpolation; its `sync_mode` doc string: "If True, the media will be returned as a data URI and the output data won't be available in the request history" | https://fal.ai/models/fal-ai/film/video/api |
| `fal-ai/ffmpeg-api/compose` | composition utility | https://fal.ai/models/fal-ai/ffmpeg-api/compose/api |

#### Realtime / interactive video (see 1.3)

| Endpoint id | Kind | Price | Source |
| --- | --- | --- | --- |
| `minimax/h3-max/director` | continuous generated video stream, WebRTC via WMA bridge | $0.08/s, 60 s minimum ($4.80), sessions up to 15 min, 480p/768p (model page showed a $0.02/s promo "expires Sep 14", 1080p 2x) | https://fal.ai/h3-max-director, https://fal.ai/models/minimax/h3-max/director/api |
| `decart/lucy-2-5/realtime` | live video-to-video editing at 30 fps, WebSocket signalling + WebRTC media | $0.02/s | https://fal.ai/models/decart/lucy-2-5/realtime/api, https://fal.ai/explore/decart |
| `decart/lucy2-vton/realtime` | live virtual try-on | $0.02/s | https://fal.ai/explore/decart |

### 1.2 Queue vs sync for video

Verdict: use `queue.fal.run` for every video endpoint. Every video OpenAPI document fetched is served against `https://queue.fal.run` and exposes only the four queue paths (submit, status, result, cancel). fal's own docs call asynchronous inference "the recommended way" and describe sync `run()` as "a convenience wrapper for simple blocking calls" with "no queue involved" and only client-side retries on 502/503/504 (https://fal.ai/docs/documentation/model-apis/inference/synchronous.md, https://fal.ai/docs/model-endpoints/queue). No published hard timeout for sync `fal.run` was found (UNVERIFIED), but there are no server-side retries, and `X-Fal-Request-Timeout` is a time-to-start deadline, not a total budget, so it does not help a sync call survive a multi-minute render.

Queue protocol (https://fal.ai/docs/model-endpoints/queue, https://fal.ai/docs/documentation/model-apis/common-parameters.md):

| Operation | Method and path | Notes |
| --- | --- | --- |
| Submit | `POST https://queue.fal.run/{model-id}` | body is the model input; response `{ request_id, response_url, status_url, cancel_url, queue_position }` |
| Status | `GET https://queue.fal.run/{model-id}/requests/{request_id}/status?logs=1` | `status` is `IN_QUEUE` (with `queue_position`), `IN_PROGRESS` (with `logs`), `COMPLETED` (with `logs` and `metrics.inference_time`) |
| Status stream | `GET https://queue.fal.run/{model-id}/requests/{request_id}/status/stream?logs=1` | SSE of status objects until completion; this streams status and logs, not media |
| Result | `GET https://queue.fal.run/{model-id}/requests/{request_id}` | model output envelope |
| Cancel | `PUT https://queue.fal.run/{model-id}/requests/{request_id}/cancel` | `202 Accepted` or `400 Bad Request` |

`logs` entries are `{ "message": "...", "timestamp": "..." }`. Submit query params: `fal_webhook=<url>`, `priority` (`normal` default or `low`), `fal_max_queue_length` (reject with 429 if the queue is longer). Headers: `X-Fal-Request-Timeout` (seconds, server-side time-to-start deadline, `504` if exceeded before processing), `X-Fal-Queue-Priority` (`normal`/`low`), `X-Fal-Runner-Hint` (session affinity), `X-Fal-No-Retry` (`1`/`true`/`yes`), `X-Fal-Retry-Config` (JSON per-condition retry counts), `X-Fal-Object-Lifecycle-Preference` (JSON, see 1.5), `X-Fal-Store-IO: 0` (do not store JSON payloads), `x-app-fal-disable-fallback`. Queue submissions retry server-side "up to 10 times with intelligent backoff" on server errors, timeouts and rate limits (https://fal.ai/docs/model-endpoints/queue, https://fal.ai/docs/documentation/model-apis/concurrency-limits.md).

Webhooks (https://fal.ai/docs/model-endpoints/webhooks): pass `?fal_webhook=https://…` on submit. Payload:

```json
{ "request_id": "<uuid>", "gateway_request_id": "<uuid>", "status": "OK" | "ERROR", "payload": { … }, "error": "…", "payload_error": "…" }
```

Delivery: 15 s timeout on the first attempt, 120 s on retries, up to 31 attempts with backoff, retried on timeouts, network errors and non-2xx; 3xx is a permanent failure; private/loopback targets dropped. The page states results are retained "approximately 1 hour (6 minutes for results >= 10 KB)" for redelivery. Headers `X-Fal-Webhook-Request-Id`, `X-Fal-Webhook-User-Id`, `X-Fal-Webhook-Timestamp` (unix seconds), `X-Fal-Webhook-Signature` (hex ED25519 over `request_id\nuser_id\ntimestamp\nsha256(body)`; verify against `https://rest.fal.ai/.well-known/jwks.json`, cache 24 h, timestamp leeway 5 min). Webhook source IP ranges from `GET https://api.fal.ai/v1/meta` (`webhook_ip_ranges`).

Concurrency (https://fal.ai/docs/documentation/model-apis/concurrency-limits.md): new accounts get 2 concurrent `IN_PROGRESS` requests, scaling with paid credits up to 40 self-serve, more via sales; `IN_QUEUE` does not count; over-limit direct calls get `429` type `concurrent_requests_limit`; queued requests are never dropped, they wait. Per-endpoint caps may apply on high-demand models. No requests-per-minute limit is documented.

### 1.3 Streaming and progressive delivery

The three kinds, with exact findings:

(a) Progressive chunks of one queued video while it renders: NONE FOUND on fal's hosted video endpoints. Checked OpenAPI documents (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=…`) for `fal-ai/veo3.1`, `fal-ai/veo3.1/image-to-video`, `fal-ai/kling-video/v3/pro/text-to-video`, `fal-ai/kling-video/v3/turbo/pro/text-to-video`, `minimax/h3-max/text-to-video`, `minimax/h3-max/image-to-video`, `bytedance/seedance-2.5/text-to-video`, `alibaba/wan-3.0-prime/image-to-video`, `lightricks/ltx-2.5/image-to-video/fast`, `fal-ai/ltx-2-19b/text-to-video`, `fal-ai/ltx-video`, `fal-ai/sync-lipsync/v2`, `fal-ai/topaz/upscale/video`: none has a `/stream` path. The LTX-2.5 and LTX-2.3 landing pages and the LTX-2.5 fast API page mention no streaming (https://fal.ai/ltx-2.5, https://fal.ai/ltx-2.3, https://fal.ai/models/lightricks/ltx-2.5/text-to-video/fast/api). fal's streaming docs say "Streaming is only supported by models that have a /stream endpoint" and the only worked example is `fal-ai/flux/schnell` at `https://fal.run/fal-ai/flux/schnell/stream` (https://fal.ai/docs/documentation/model-apis/inference/streaming). The serverless streaming guide (`@fal.endpoint("/stream")`, SSE `data: {json}\n\n`, client `fal.stream()` then `stream.done()`) is for your own deployed apps; its examples are diffusion-step image previews and the progressive 3D example streams voxels, not video (https://fal.ai/docs/serverless/development/streaming, https://fal.ai/docs/examples/video-generation/deploy-3d-progressive-rendering.md). The third-party api-evangelist README claims `/stream` is used for "incremental video frames" (https://github.com/api-evangelist/fal-ai); UNVERIFIED and contradicted by every schema above. Treat (a) as unavailable on fal unless you deploy your own streaming app.

Two things that look like (a) but are not: the queue `…/status/stream?logs=1` SSE streams status objects and logs, not media; "HTTP over WebSockets" at `wss://ws.fal.run/{model_id}` (auth `Authorization: Key $FAL_KEY` on the handshake, send JSON payload, receive a JSON headers frame, then response data "as a sequence of messages" that "can be binary chunks for media content", then an end-of-stream JSON frame) "works with any endpoint" but it is a transport for the finished response, not progressive rendering (https://fal.ai/docs/documentation/model-apis/inference/websockets.md).

(b) Real-time interactive sessions (persistent connection, live frames):

- `minimax/h3-max/director`: "publishes a WMA WebRTC contract". Client: `import { wma } from "@fal-ai/client/realtime"; const session = fal.realtime.open(wma("minimax/h3-max/director"), { onMedia, onData, onState, onDiagnostic, onError })`. Video and audio arrive as live WebRTC tracks (24 fps, 48 kHz stereo); directions go back on a data channel. Client messages: `configure` (prompt, resolution 480p/768p, aspect ratio 16:9/9:16/1:1, first/last frames, target audio, script beats, memory context, seed, audio bitrate 96000/128000/192000), `prompt`, `ping`, `stop`. Server messages: `configured`, `prompt_applied`, `prompt_pending`, `prompt_rejected`, `chunk` (with `chunk_index`, `generated_frame_count`, `playback_seconds`, resolution metadata; segments continue from 39 frames of context with overlaps removed), `audio_applied`, `audio_exhausted`, `error`, `stream_exhausted`. Correlation via `prompt_version`. Sessions up to 15 min public; billing $0.08/s with a 60 s minimum. An AsyncAPI document is linked from the API page. (https://fal.ai/models/minimax/h3-max/director/api, https://fal.ai/h3-max-director)
- `decart/lucy-2-5/realtime` and `decart/lucy2-vton/realtime`: `fal.realtime.connect("decart/lucy-2-5/realtime")`, "Real-time via WebSockets" for signalling, media "flows peer-to-peer between the browser and Decart" over WebRTC (`iceServers`, `sdp`, `candidate` in the schema). Inputs `prompt`, `reference_image_url`, `enable_prompt_expansion`, `image_url` (live camera frame source when not in WebRTC mode). $0.02/s. (https://fal.ai/models/decart/lucy-2-5/realtime/api, https://fal.ai/explore/decart)
- The `@fal-ai/client` realtime kernel (fal-js PR #226): `fal.realtime.open(extension, options)` returns a session with `state` (`opening | live | failed | closed`), `send(input)`, `close()`, `ready`; extensions `wma(endpointId)` (WebRTC through the `wma.fal.run` bridge), `websocket(endpointId)` (msgpack), `lucyRealtime()`; callbacks `onMedia(stream)`, `onData(raw)`, `onState`, `onDiagnostic`, `onError` (https://github.com/fal-ai/fal-js/pull/226). The classic `fal.realtime.connect` msgpack WebSocket path (`wss://fal.run/{app}/realtime`, `throttleInterval`) is documented only with image models `fal-ai/fast-lcm-diffusion` and `fal-ai/fast-turbo-diffusion` (https://fal.ai/docs/documentation/model-apis/inference/real-time). Serverless realtime endpoints use `@fal.realtime("/realtime")`; for video/audio fal points at the "experimental World Model Accelerator (WMA)" wrapper (https://fal.ai/docs/documentation/development/realtime.md). The realtime video-to-video serverless example is WebRTC frame-by-frame (`…/webrtc` path) (https://fal.ai/docs/examples/video-generation/deploy-realtime-video-to-video-model.md).
- Krea, StreamDiffusion, Odyssey, MirageLSD: no fal endpoint ids found. `fal-ai/krea-wan-14b/video-to-video` is a plain queue endpoint. `mirage-api/avatar-x/reference-to-video` is a queue endpoint. MirageLSD is referenced only as Decart research (https://fal.ai/learn/tools/real-time-video-editing-with-ai). Odyssey: UNVERIFIED, nothing found.

(c) Plain fast async: everything else. fal's own timing article (https://fal.ai/learn/tools/fastest-ai-video-generation-models): `minimax/h3-max-turbo/text-to-video` 1.61 s, `minimax/h3-max/text-to-video` 2.82 s, `fal-ai/kling-video/v3/turbo/pro/text-to-video` 60.72 s, `lightricks/ltx-2.5/text-to-video/fast` 75.17 s, `bytedance/seedance-2.0/mini/text-to-video` 117.32 s. Even the sub-3-second ones are queue endpoints.

Design implication for `VideoGenerator`: model a queued job with status polling (or webhook) and a final file as the base case; expose a separate realtime session capability (WebRTC/WebSocket, browser or WebRTC-capable runtime) only if H3 Max Director / Lucy are in scope. There is no progressive-bytes-of-one-mp4 surface to abstract.

### 1.4 Common input fields across families

From the OpenAPI documents (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`):

| Field | Veo 3.1 (`fal-ai/veo3.1`, `/image-to-video`) | Kling v3 (`…/v3/pro/text-to-video`, `/image-to-video`) | H3 Max (`minimax/h3-max/*`) | Seedance 2.5 (`bytedance/seedance-2.5/*`) | Wan 3.0 Prime (`alibaba/wan-3.0-prime/image-to-video`) | LTX-2.5 fast (`lightricks/ltx-2.5/image-to-video/fast`) | LTX-2 19B (`fal-ai/ltx-2-19b/text-to-video`) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `prompt` | required, max 20000 | max 2500 (turbo: 3072), nullable when `multi_prompt` given | required, 1-50000 | required | nullable, max 20000 | required, 1-5000 | required |
| first image | `image_url` | `start_image_url` | `image_url` | `image_url` | `start_image_url` | `image_url` | n/a |
| last image | separate endpoint `first-last-frame-to-video` | `end_image_url` | `end_image_url` | `end_image_url` | `end_image_url` | `end_image_url` | n/a |
| `duration` | enum string `"4s"`, `"6s"`, `"8s"` (default `"8s"`) | enum string `"3"`…`"15"` (default `"5"`) | integer 5-15 (default 5) | string `"auto"` or `"4"`…`"30"` (default `"auto"`) | integer 2-30 (default 5) | enum 6,8,…,20 or `"auto"` (default `"auto"`) | n/a, uses `num_frames` 9-481 (default 121) and `fps` 1-60 (default 25) |
| `aspect_ratio` | `"16:9"`, `"9:16"` (i2v adds `"auto"`) | `"16:9"`, `"9:16"`, `"1:1"` (i2v: derived from image) | `"16:9"`, `"21:9"`, `"4:3"`, `"1:1"`, `"3:4"`, `"9:16"` | `"auto"`, `"21:9"`, `"16:9"`, `"4:3"`, `"1:1"`, `"3:4"`, `"9:16"` | `"adaptive"`, `"16:9"`, `"4:3"`, `"1:1"`, `"3:4"`, `"9:16"` | `"auto"`, `"16:9"`, `"9:16"` | `video_size` presets (default `landscape_4_3`) |
| `resolution` | `"720p"`, `"1080p"`, `"4k"` | not a field on v3 pro (4k is a separate endpoint) | `"480P"`, `"768P"`, `"1080P"` (upper-case P) | `"480p"`, `"720p"`, `"1080p"` (i2v: 480p/720p only) | `"480p"`, `"720p"`, `"1080p"` | `"720p"`, `"1080p"`, `"1440p"`, `"2160p"` | n/a |
| audio toggle | `generate_audio` (default true) | `generate_audio` (default true) | none (always audio; `target_audio_url` to condition) | `generate_audio` (default true) | `audio` (default true) | `generate_audio` (default true) | `generate_audio` (default true) |
| `negative_prompt` | nullable string | default `"blur, distort, and low quality"` | none | none | none | none | yes |
| `seed` | nullable int | none | nullable int | none on t2v (i2v has `seed`) | 0-2147483647 | none | yes |
| `fps` | none | none | none | none | none | 24, 25, 48, 50 (default 25) | 1-60 |
| `camera_fixed` | none | none | none | none (Vercel exposes `cameraFixed` for Seedance via the ByteDance API, so fal may hide it) | none | `camera_motion` enum (`dolly_in`, `dolly_out`, `dolly_left`, `dolly_right`, `jib_up`, `jib_down`, `static`, `focus_shift`) | `camera_lora`, `camera_lora_scale` |
| `enable_safety_checker` | `safety_tolerance` `"1"`…`"6"` (default `"4"`) | none | `enable_safety_checker` (default true) | none | `enable_safety_checker` (default true) | none | `enable_safety_checker` |
| prompt enhancement | `auto_fix` (default true on t2v, false on i2v) | none | `prompt_expansion_mode` `"disabled"`, `"balanced"`, `"quality"` | none | `enable_prompt_expansion` (default true), `enable_thinking` | none | `enable_prompt_expansion` |
| `sync_mode` | absent | absent | present (`false`): "Return the generated video as base64 instead of a CDN URL" | absent | absent | absent | present ("Data URI return toggle") |
| other | | `cfg_scale` 0-1 (default 0.5), `multi_prompt` (1-6 shots, each `prompt` + `duration`), `shot_type` (`customize`/`intelligent`), `elements` | `target_audio_url` (>= 2 s, <= 15 MB) | `bitrate_mode` (`standard`/`high`), `end_user_id` | | | `guidance_scale`, `num_inference_steps`, `acceleration`, `video_output_type` (MP4/WebM/ProRes/GIF), `video_quality`, `video_write_mode` |

Consistency verdict: `prompt`, `generate_audio` (Wan calls it `audio`), `aspect_ratio` and `resolution` are near-uniform in name but not in enum spelling (`"768P"` vs `"720p"`, `"4k"`), `end_image_url` is uniform where supported, the first-frame field splits between `image_url` (Veo, MiniMax, Seedance, LTX) and `start_image_url` (Kling v3, Wan 3.0 Prime), and `duration` is the least uniform field (string with unit, string without unit, integer, `"auto"`, or absent in favour of `num_frames`). Any common request should carry `prompt`, optional first/last image, optional `durationSeconds` number, optional `aspectRatio`, optional `resolution`, optional `audio` boolean, optional `seed`, optional `negativePrompt`, and leave the rest provider-typed; each fal endpoint needs its own codec for `duration`.

### 1.5 Output envelope

Every video endpoint returns `{ "video": File, … }` where `File` is `{ url: string (required), content_type: string | null, file_name: string | null, file_size: integer | null }`. Some endpoints use a `VideoFile` superset adding `width`, `height`, `fps`, `duration`, `num_frames` (`lightricks/ltx-2.5/*`, `alibaba/wan-3.0-prime/*`, `xai/grok-imagine-video/v1.5/*`). Extra top-level fields vary: `seed` (Seedance 2.5, Wan 3.0 Prime, LTX-2-19b), `prompt` echo (LTX-2-19b), `actual_prompt` (Wan 3.0 Prime), `expanded_prompt` and `timings` (MiniMax H3), `duration` number (Wan 3.0 Prime). `has_nsfw_concepts` was not present on any video schema fetched (it is an image-endpoint field).

`sync_mode` for video: only present on a subset (MiniMax H3 family, LTX-2-19b, FILM, and per the search snippet some older `fal-ai/*` video-to-video utilities). Where present it returns the video as a base64 data URI in `video.url` and the output is then not stored in request history. Absent on Veo, Kling, Seedance 2.5, Wan 3.0 Prime, LTX-2.5, so a `VideoGenerator` cannot rely on it. No documented size ceiling for data-URI outputs (UNVERIFIED). Beware the name collision: `fal-ai/sync-lipsync/v2` also has `sync_mode` but it means audio/video duration reconciliation.

Result URLs: served from `https://v3b.fal.media/files/...` (also `v3.fal.media`, `fal.media`). Retention is set per request via `X-Fal-Object-Lifecycle-Preference` with `expiration_duration_seconds` (number, or `null` for indefinite); "Expired files are permanently deleted and cannot be recovered." The page did not state the default lifetime (UNVERIFIED default). Request JSON payloads are kept 30 days unless `X-Fal-Store-IO: 0`. (https://fal.ai/docs/documentation/model-apis/media-expiration.md)

### 1.6 Pricing and speed

Pricing is per second of output for almost all video endpoints; "Server errors are never billed", queue wait is free (https://fal.ai/docs/documentation/model-apis/pricing.md). Model page prices, September 2026:

| Endpoint | Price |
| --- | --- |
| `fal-ai/veo3.1` (standard) | 720p/1080p $0.20/s no audio, $0.40/s with audio; 4K $0.40/s / $0.60/s (https://fal.ai/models/fal-ai/veo3.1) |
| `fal-ai/veo3.1/fast` | 720p/1080p $0.10/s / $0.15/s; 4K $0.30/s / $0.35/s |
| `fal-ai/sora-2/text-to-video` | $0.10/s, deprecated, shutdown 2026-09-24 |
| `fal-ai/kling-video/v3/pro/image-to-video` | $0.112/s audio off, $0.168/s audio on, $0.196/s voice control (https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video) |
| `fal-ai/kling-video/v3/turbo/pro/text-to-video` | $0.14/s at 1080p (fal timing article) |
| `fal-ai/kling-video/v2.5-turbo/pro/*` | $0.07/s (https://fal.ai/pricing) |
| `minimax/h3-max/text-to-video` | $0.025/s 480p, $0.04/s 768p, $0.08/s 1080p at a 50% promo "until September 30"; doubles after (https://fal.ai/models/minimax/h3-max/text-to-video) |
| `minimax/h3-max-turbo/text-to-video` | $0.04/s 768p |
| `minimax/h3-max/director` | $0.08/s, 60 s minimum |
| `bytedance/seedance-2.5/image-to-video` | token-priced: $0.0214 per 1000 tokens, tokens = height x width x seconds x 24 / 1024; about $0.22/s 480p, $0.47/s 720p, $1.16/s 1080p as computed on the page (https://fal.ai/models/bytedance/seedance-2.5/image-to-video) |
| `bytedance/seedance-2.0/mini/text-to-video` | about $0.155/s 720p |
| `bytedance/seedance-2.0/fast/text-to-video` | about $2.42 per 10 s clip vs about $3.03 standard |
| `fal-ai/bytedance/seedance/v1/pro/text-to-video` | about $0.62 per 5 s 1080p; lite $0.18 per 5 s 720p |
| `alibaba/wan-3.0-prime/text-to-video` | $0.068/s 480p, $0.14/s 720p, $0.28/s 1080p (https://fal.ai/models/alibaba/wan-3.0-prime/text-to-video) |
| `fal-ai/wan-25-preview/*` | $0.05/s (https://fal.ai/pricing) |
| `lightricks/ltx-2.5/*/fast` | $0.09/s 720p, $0.13/s 1080p, $0.19/s 1440p, $0.30/s 4K; pro i2v $0.12/s 720p, $0.17/s 1080p; audio-to-video billed per input audio second (https://fal.ai/ltx-2.5) |
| `fal-ai/ltx-2.3/*` | pro $0.06/s 1080p, $0.12/s 1440p, $0.24/s 2160p; fast $0.04/s, $0.08/s, $0.16/s; audio-to-video / extend / retake $0.10/s (https://fal.ai/ltx-2.3) |
| `fal-ai/hunyuan-video-v1.5/text-to-video` | $0.075/s 480p |
| `fal-ai/pika/v2.2/text-to-video` | $0.20 per 5 s 720p, $0.45 per 5 s 1080p |
| `xai/grok-imagine-video/v1.5/text-to-video` | $0.08/s 480p, $0.14/s 720p, $0.25/s 1080p |
| `decart/lucy-2-5/realtime` | $0.02/s; `decart/lucy-edit/pro` $0.10/s; `fal-ai/decart/lucy-5b/image-to-video` $0.15/video |
| Veo 3 (older) | $0.40/s (https://fal.ai/pricing) |

Prices for Luma, Vidu, Hunyuan v1, lipsync and upscalers were not captured (page renders client-side); UNVERIFIED.

### 1.7 Uploads

Official path: `fal.storage.upload(file)` (JS) / `fal_client.upload_file(path)` (Python) returns a persistent CDN URL like `https://v3b.fal.media/files/b/{prefix}/{filename}`. The SDK tries `v3.fal.media`, falls back to `fal.media`, then to the REST API. Multipart (10 MB parts) kicks in above 90 MB in JS (100 MB in Python). Auth via `FAL_KEY`. Docs advise against data URIs beyond "a few KB" because they inflate the payload; model pages say data URIs are accepted for `image_url` / `video_url` but "can impact request performance" for large files. No global upload size limit is documented; "Individual models may enforce their own size and format limits." (https://fal.ai/docs/documentation/model-apis/fal-cdn.md)

REST shape from third-party sources (UNVERIFIED against an official page; the `docs.fal.ai/model-endpoints/storage` URL now 404s): `POST https://rest.alpha.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3` with `Authorization: Key {FAL_KEY}` returning `upload_url` and `file_url`, then `PUT` bytes to `upload_url`; `…/storage/upload/initiate-multipart` for large files (https://github.com/fal-ai/fal-js/pull/239, https://apis.io/collections/fal-ai/postman-fal-storage-api/). The fal-js client source is the authoritative reference for exact field names.

## 2. Pruna AI

### 2.1 What it is

Pruna describes itself as "a model laboratory and inference provider" with two products: the open-source `pruna` compression/optimisation framework (GitHub `PrunaAI/pruna`) and "Pruna Endpoints", hosted "Performance Models" served "on Pruna and with partner inference platforms" (https://docs.pruna.ai/, https://docs.pruna.ai/en/stable/docs_pruna_endpoints/index.html). Partners listed: Cloudflare, ComfyUI, Gamma, inference.sh, Kittl, Leonardo AI, Lovart, Magnific, Picsart, Replicate, Runware, Scenario, Together AI, WaveSpeed, Prodia, Runpod, Eachlabs, Tellers AI, Segmind, Wiro. fal is not on that list and no `fal.ai/models` page for Pruna was found. "Flux-juiced" is Pruna's older name for its optimised FLUX endpoints (Hugging Face blog, `prunaai/flux.1-juiced` on Replicate).

### 2.2 Hosted API (P-API)

Own API, base `https://api.pruna.ai/v1/`, auth header `apikey: <key>`, keys from `https://dashboard.pruna.ai` (https://docs.api.pruna.ai/guides/quickstart, https://docs.api.pruna.ai/apis/models-api-0/versions/a80cf098-b7a8-4f6e-b1e0-43b06bfa4038).

| Operation | Path |
| --- | --- |
| Submit | `POST /v1/predictions` with body `{ "input": { … } }` (how the model id is addressed, path segment or body field, was not captured verbatim: UNVERIFIED) |
| Status | `GET /v1/predictions/status/{id}` |
| Download | `GET /v1/predictions/delivery/{path}` (returned as `generation_url`) |
| Upload | `POST /v1/files` (multipart `content=@file`) |

Response: async by default, `{ "id", "status": "starting" | "processing", "get_url" }`, then `{ "status": "succeeded", "generation_url": "https://api.pruna.ai/v1/predictions/delivery/…/output.mp4" }` or `"failed"`. `Try-Sync: true` header "will wait up to 60 seconds for completion" and returns the result inline if ready. No webhooks and no streaming in the spec. Rate limits: P-models 250 req/min, other image models 150 req/min, video models 30 req/min, status endpoint 30,000 req/min, delivery 10,000 req/min.

Video model ids and pricing (https://docs.api.pruna.ai/guides/models, https://docs.pruna.ai/en/stable/docs_pruna_endpoints/performance_models/p-video-2.html, …/p-video-2-pro.html, https://replicate.com/prunaai/p-video):

| Model id | Modalities | Inputs | Price (per output second) |
| --- | --- | --- | --- |
| `p-video` | t2v, i2v, audio-to-video | `prompt`, `image`, `audio`, `duration` 1-10 (ignored with audio), `aspect_ratio`, `resolution` 720p/1080p, `fps` 24/48, `draft`, `prompt_upsampling`, `seed` | 720p $0.02 (draft $0.005), 1080p $0.04 (draft $0.01) |
| `p-video-2` | t2v, i2v, audio-conditioned | `prompt`, `image`, `audio`, `duration` 1-20, `resolution` 720p/1080p, `fps` 24/48, `draft` | 720p $0.025 (draft $0.015), 1080p $0.05 (draft $0.03); about 0.91 s compute per output second |
| `p-video-2-pro` | t2v, i2v with last frame, generated audio | `prompt`, `image`, `last_frame_image`, `duration` 5-15, `resolution` 480p/768p, `mode` `speed`/`quality`, `prompt_upsampler` `off`/`turbo`/`max`, `aspect_ratio` | 480p $0.02/$0.04, 768p $0.035/$0.075 (speed/quality); about 0.85 s per output second at 768p speed |
| `p-video-avatar` | image + audio lipsync | | $0.025-$0.045/s |
| `p-video-animate`, `p-video-replace` | motion transfer / person swap | | $0.03-$0.06/s |
| `p-video-edit` | prompt-based video edit | | $0.025-$0.045/s |
| `wan-t2v`, `wan-i2v` | Wan 2.x | | $0.05-$0.11 per video |
| `vace` | Wan VACE | | $0.40 per video |

"Draft mode" is a cheaper low-quality full render for iteration, not a progressive preview stream. No streaming of any kind. The same models are on Replicate under `prunaai/*` (`prunaai/p-video`, `prunaai/p-video-2`, `prunaai/p-video-2-pro`, `prunaai/p-video-avatar`, …) using Replicate's predictions API (https://replicate.com/prunaai); Cloudflare's "Use Pruna P-video through AI Gateway" tutorial routes to Replicate, not to Pruna's API (https://developers.cloudflare.com/ai-gateway/tutorials/pruna-p-video).

### 2.3 Verdict on a `@effect-uai/pruna` package

Distinct from fal: Pruna has its own API host, auth header, job model and model ids, and is not hosted on fal. It is a small Replicate-shaped async predictions API (submit, poll status, download) with one vendor's model family. A package would be legitimately its own thing, but it buys only Pruna's models (cheap, fast P-Video/P-Image) and the same models are reachable through `@effect-uai/replicate` if that ever exists. Recommendation: not a first-wave provider for `VideoGenerator`; revisit if cost-per-second matters (P-Video-2 at $0.025/s vs H3 Max $0.08/s list, Kling v3 $0.11+/s).

## 3. Replicate

Routes video generation as ordinary predictions. Model ids seen in the text-to-video collection (https://replicate.com/collections/text-to-video): `google/veo-3.1`, `google/veo-3.1-fast`, `google/veo-3.1-lite`, `openai/sora-2`, `openai/sora-2-pro` (Sora 2 API sunset 2026-09-24 per OpenAI, UNVERIFIED on Replicate's page), `kwaivgi/kling-v3-video`, `kwaivgi/kling-v3-omni-video`, `kwaivgi/kling-v2.5-turbo-pro`, `bytedance/seedance-2.0`, `bytedance/seedance-2.0-fast`, `bytedance/seedance-1.5-pro`, `bytedance/seedance-1-lite`, `minimax/hailuo-2.3`, `minimax/hailuo-2.3-fast`, `alibaba/wan-3`, `wan-video/wan-2.7-t2v`, `wan-video/wan-2.5-t2v`, `wan-video/wan-2.5-t2v-fast`, `wan-video/wan-2.5-i2v-fast`, `runwayml/gen-4.5`, `luma/ray-3.2`, `vidu/q3-pro`, `vidu/q3-turbo`, `pixverse/pixverse-v6`, `pixverse/pixverse-v5.6`, `xai/grok-imagine-video-1.5`, `alibaba/happyhorse-1.1`, `prunaai/p-video`.

Request shape (https://replicate.com/docs/topics/predictions/create-a-prediction): `POST https://api.replicate.com/v1/models/{owner}/{name}/predictions` (official models) or `POST /v1/predictions` with `version` (community), body `{ "input": { … }, "webhook", "webhook_events_filter" }`. `Prefer: wait` holds the request open, "defaults to 60 seconds", `Prefer: wait=N` to change; "If the model doesn't finish within the specified duration, the request will return the incomplete prediction object with status set to starting or processing", then poll `urls.get`. Status values `starting`, `processing`, `succeeded`, `failed` (plus `canceled`; the fetched summary spelled the terminal state "successful", Replicate's API uses `succeeded`). Output file URLs point at `replicate.delivery` and "will expire after one hour"; API-created prediction files are deleted after one hour (https://replicate.com/docs/topics/predictions/output-files). Streaming (`stream: true`, `urls.stream`, SSE) is documented for language models only; no progressive video. Verdict: a generic async-predictions gateway with one-hour output URLs; no streaming; docs-only for us unless a Replicate provider is wanted for breadth (it is the only aggregator here carrying Runway and Luma Ray 3).

## 4. Vercel AI Gateway

Routes video generation (https://vercel.com/docs/ai-gateway/modalities/video-generation, https://vercel.com/docs/ai-gateway/modalities/video-generation/text-to-video). Model ids: `google/veo-3.1-generate-001`, `google/veo-3.1-fast-generate-001`, `google/veo-3.0-fast-generate-001`, `klingai/kling-v3.0-t2v`, `klingai/kling-v3.0-i2v`, `alibaba/wan-v2.6-t2v`, `alibaba/wan-v2.6-i2v`, `alibaba/wan-v2.5-t2v-preview`, `bytedance/seedance-2.5` (covers t2v, i2v, r2v, edit, extend), `spacexai/grok-imagine-video`; MiniMax H3 / H3 Max and Wan 3.0 announced in changelogs. Capability tags `t2v`, `i2v`, `r2v`, `motion-control`; full list via `/v1/models` or `https://vercel.com/ai-gateway/models?capabilities=video-generation`.

Shape: AI SDK `experimental_generateVideo({ model, prompt | { image, text }, duration, aspectRatio, resolution ('1920x1080' style), generateAudio, frameImages [{ image, frameType: 'first_frame' | 'last_frame' }], inputReferences, providerOptions, poll: { intervalMs, timeoutMs } })` returning `result.videos[i].uint8Array | base64`; async job split into `experimental_startVideo` (returns `operation`, `providerMetadata.gateway.asyncJob.{jobId, webhookSigningSecret}`) and `experimental_getVideoStatus` (`pending | completed | error`, `videos` entries typed `url | base64 | binary`). Underlying REST: `…/video-model/start` (the status path was not captured; UNVERIFIED). Async start requests capped at 300 KiB (use hosted URLs). Webhook events `video.generation.completed | failed | cancelled`, header `x-ai-gateway-signature: t=<unix>,v1=<hmac-sha256 hex>`, idempotency header `x-ai-gateway-idempotency-key: <jobId>-<status>`, 2xx within 10 s. Hosted results carry `expiresAt`. Default provider poll timeouts 10 min (Seedance 5 min). No streaming or progressive delivery. Zero markup on provider prices. Verdict: a polling job API wrapped for the AI SDK; useful as a docs-only reference for field normalisation (their `frameImages` / `inputReferences` split is a sensible shape), not a transport we need.

## 5. OpenRouter

Routes video generation since 2026-04-16 (https://openrouter.ai/docs/guides/overview/multimodal/video-generation, https://openrouter.ai/blog/announcements/video-generation/). Models (https://openrouter.ai/collections/video-models): `google/veo-3.1-lite` $0.05/s, `google/veo-3.1-fast` $0.10/s, `bytedance/seedance-2.5` $0.1028/s, `bytedance/seedance-2.0` $0.06726/s, `bytedance/seedance-2.0-fast` $0.04035/s, `bytedance/seedance-2.0-mini` $0.03363/s, `alibaba/wan-3.0` $0.0425/s, `minimax/hailuo-3-max` $0.05/s, `x-ai/grok-imagine-video` $0.05/s, `x-ai/grok-imagine-video-1.5` $0.08/s; Veo 3.1, Wan 2.7/2.6, Sora 2 Pro also announced.

Shape: `POST /api/v1/videos` with `{ model, prompt, duration, resolution ('480p'…'4K'), aspect_ratio, size ('WxH'), frame_images, input_references, generate_audio, seed, callback_url, provider }` returns `{ id, polling_url, status: "pending" }`; `GET /api/v1/videos/{id}` returns `status` `pending | in_progress | completed | failed`, then `unsigned_urls: ["https://openrouter.ai/api/v1/videos/{id}/content?index=0"]` and `usage.cost`; download via `GET /api/v1/videos/{id}/content?index=0` with the API key. Model capability discovery via `GET /api/v1/videos/models` (`supported_durations`, `supported_resolutions`, `supported_aspect_ratios`, `pricing_skus`, `allowed_passthrough_parameters`) or `GET /api/v1/models?output_modalities=video`. Webhooks: `video.generation.completed | failed | cancelled | expired`, `X-OpenRouter-Idempotency-Key: <job_id>-<status>`, optional `X-OpenRouter-Signature` HMAC-SHA256. No zero-data-retention for video. No streaming or progressive delivery. Verdict: clean, small async job API with a normalised schema; a plausible second provider after fal if one aggregator-of-aggregators is wanted, otherwise docs-only.

## Sources

- https://fal.ai/docs/model-endpoints/queue
- https://fal.ai/docs/model-endpoints/webhooks
- https://fal.ai/docs/documentation/model-apis/inference/synchronous.md
- https://fal.ai/docs/documentation/model-apis/inference/streaming
- https://fal.ai/docs/documentation/model-apis/inference/real-time
- https://fal.ai/docs/documentation/model-apis/inference/websockets.md
- https://fal.ai/docs/serverless/development/streaming
- https://fal.ai/docs/documentation/development/realtime.md
- https://fal.ai/docs/documentation/model-apis/fal-cdn.md
- https://fal.ai/docs/documentation/model-apis/media-expiration.md
- https://fal.ai/docs/documentation/model-apis/concurrency-limits.md
- https://fal.ai/docs/documentation/model-apis/common-parameters.md
- https://fal.ai/docs/documentation/model-apis/model-arguments.md
- https://fal.ai/docs/documentation/model-apis/pricing.md
- https://fal.ai/docs/examples/video-generation/deploy-realtime-video-to-video-model.md
- https://fal.ai/docs/examples/video-generation/deploy-3d-progressive-rendering.md
- https://fal.ai/docs/llms.txt
- https://fal.ai/models?categories=text-to-video
- https://fal.ai/models?categories=image-to-video
- https://fal.ai/models?categories=video-to-video
- https://fal.ai/video
- https://fal.ai/pricing
- https://fal.ai/learn/tools/fastest-ai-video-generation-models
- https://fal.ai/h3-max-director
- https://fal.ai/models/minimax/h3-max/director/api
- https://fal.ai/models/decart/lucy-2-5/realtime/api
- https://fal.ai/explore/decart
- https://fal.ai/ltx-2.5
- https://fal.ai/ltx-2.3
- https://fal.ai/models/lightricks/ltx-2.5/text-to-video/fast/api
- https://fal.ai/models/fal-ai/veo3.1
- https://fal.ai/models/fal-ai/sora-2/text-to-video
- https://fal.ai/models/fal-ai/kling-video/v3/pro/image-to-video
- https://fal.ai/models/alibaba/wan-3.0-prime/text-to-video
- https://fal.ai/models/minimax/h3-max/text-to-video
- https://fal.ai/models/bytedance/seedance-2.5/image-to-video
- https://fal.ai/models/xai/grok-imagine-video/v1.5/text-to-video
- https://fal.ai/models/fal-ai/krea-wan-14b/video-to-video/api
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/veo3.1
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/veo3.1/image-to-video
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/kling-video/v3/pro/text-to-video
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/kling-video/v3/turbo/pro/text-to-video
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/text-to-video
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=minimax/h3-max/image-to-video
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=bytedance/seedance-2.5/text-to-video
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=alibaba/wan-3.0-prime/image-to-video
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=lightricks/ltx-2.5/image-to-video/fast
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ltx-2-19b/text-to-video
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/ltx-video
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/sync-lipsync/v2
- https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/topaz/upscale/video
- https://github.com/fal-ai/fal-js/pull/226
- https://github.com/fal-ai/fal-js/pull/239
- https://github.com/api-evangelist/fal-ai
- https://docs.pruna.ai/
- https://docs.pruna.ai/en/stable/docs_pruna_endpoints/index.html
- https://docs.pruna.ai/en/stable/docs_pruna_endpoints/performance_models/p-video-2.html
- https://docs.pruna.ai/en/stable/docs_pruna_endpoints/performance_models/p-video-2-pro.html
- https://docs.api.pruna.ai/guides/quickstart
- https://docs.api.pruna.ai/guides/models
- https://docs.api.pruna.ai/apis/models-api-0/versions/a80cf098-b7a8-4f6e-b1e0-43b06bfa4038
- http://www.pruna.ai/
- https://www.pruna.ai/pricing
- https://replicate.com/prunaai
- https://replicate.com/prunaai/p-video
- https://replicate.com/prunaai/p-video-2-pro
- https://developers.cloudflare.com/ai-gateway/tutorials/pruna-p-video
- https://replicate.com/docs/topics/predictions/create-a-prediction
- https://replicate.com/docs/topics/predictions/output-files
- https://replicate.com/docs/topics/predictions/streaming
- https://replicate.com/collections/text-to-video
- https://vercel.com/docs/ai-gateway
- https://vercel.com/docs/ai-gateway/modalities/video-generation
- https://vercel.com/docs/ai-gateway/modalities/video-generation/text-to-video
- https://openrouter.ai/docs/features/multimodal/overview
- https://openrouter.ai/docs/guides/overview/multimodal/video-generation
- https://openrouter.ai/collections/video-models
- https://openrouter.ai/blog/announcements/video-generation/
