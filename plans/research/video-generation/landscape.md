# Subagent report: video generation, landscape and speed tier (2026-09-19)

Raw research report. Summarised in `../video-generation.md`. Anything not confirmed against a vendor page or a primary leaderboard is marked UNVERIFIED. Model names are quoted as the source spells them.

## 0. Headline findings

- The leaderboards have turned over almost completely since early 2026. The top of both Arena and Artificial Analysis is now Google `gemini-omni-1.1-flash`, Alibaba `wan3.0`, ByteDance `dreamina-seedance-2.5-720p` / `2.0`, MiniMax `minimax-h3` and fal's post-trained `H3 Max`, plus newcomers (Black Forest Labs `flux-3-video`, Alibaba-ATH `happyhorse-1.x`, HiDream `hidream-o1-video-1.0`, Sand.ai `MAGI-2 Preview`). Veo 3.1, Kling 3.0 and Sora 2 have slid to the 11 to 20 band.
- OpenAI Sora is being shut down. App closed 2026-04-26, and `sora-2` / `sora-2-pro` and the Videos API are removed on 2026-09-24, five days from now (https://developers.openai.com/api/docs/deprecations, https://the-decoder.com/openai-sets-two-stage-sora-shutdown-with-app-closing-april-2026-and-api-following-in-september/). Do not build a Sora adapter.
- Google's default video model in the Gemini API is no longer Veo. `gemini-omni-1.1-flash` (GA 2026-08-27) is served through the Interactions API with conversational editing and extension; Veo 3.1 stays as the specialised line (https://ai.google.dev/gemini-api/docs/video, https://ai.google.dev/gemini-api/docs/omni).
- "Fast" is now a real tier: fal's `H3 Max` renders a 5 s clip in under 3 s and `H3 Max Turbo` in 1.6 s (fal measured, 2026-09-09), i.e. faster than playback. Everything else marketed as fast is 25 s to 120 s per clip.
- Progressive delivery of a single clip (frames arriving over SSE or chunked HTTP while the clip renders) does not exist in any public vendor API today. What exists is continuous or interactive generation over WebRTC: fal `minimax/h3-max/director`, Odyssey-2 Pro, Decart Lucy 2.5, Runway Characters, Daydream (StreamDiffusionV2). Everything else is submit-then-poll.
- The MiniMax model the user recalls is `MiniMax H3` (alias Hailuo 3.0 / Hailuo 03, 2026-07-31) and its fal post-train `H3 Max` (2026-08-27), also listed on MiniMax's own platform as `MiniMax-H3-Max`. `H3 Max Director` (WebRTC, continuous) is the one that streams.

## 1. Leaderboards

### 1.1 Arena text-to-video (arena.ai/leaderboard/text-to-video, page says last updated 2026-09-04, 668,045 votes, 48 models)

| Rank | Model (as listed) | Org | Score | Public API |
|---|---|---|---|---|
| 1 | `gemini-omni-1.1-flash` | Google | 1515 | Direct (Gemini API, Interactions API; GA 2026-08-27) |
| 2 | `gemini-omni-flash` | Google | 1511 | Direct (preview id `gemini-omni-flash-preview`, deprecated 2026-09-30) |
| 3 | `wan3.0` | Alibaba | 1494 | Direct (Alibaba Cloud Model Studio, `wan3.0-video`) |
| 4 | `flux-3-video` | Black Forest Labs | 1494 | Direct (BFL API, GA via API and partners since 2026-08-05 per invideo.io; UNVERIFIED exact date) |
| 5 | `grok-imagine-video-1.5-agent` | SpaceXAI (xAI) | 1491 | Direct (xAI API `grok-imagine-video-1.5`); the "-agent" suffix is an Arena label, UNVERIFIED as an API mode |
| 6 | `dreamina-seedance-2.5-720p` | ByteDance | 1482 | Direct (BytePlus ModelArk `dreamina-seedance-2-5-260628`) |
| 7 | `dreamina-seedance-2.0-720p` | ByteDance | 1479 | Direct (BytePlus) plus fal, Replicate, OpenRouter |
| 8 | `minimax-h3` | MiniMax | 1462 | Direct (MiniMax Open Platform `MiniMax-H3`) plus fal; open weights `H3-Base` |
| 9 | `muse-video` | Meta | 1456 | None (preview only, "coming soon to creators and in Meta AI") |
| 10 | `happyhorse-1.0` | Alibaba-ATH | 1427 | Direct (Alibaba Cloud Model Studio) plus fal |
| 11 | `sora-2-pro` | OpenAI | 1367 | Direct until 2026-09-24, then removed |
| 12 | `veo-3.1-audio` | Google | 1364 | Direct (`veo-3.1-generate-preview`) |
| 13 | `veo-3.1-audio-1080p` | Google | 1363 | Direct |
| 14 | `veo-3.1-fast-audio` | Google | 1362 | Direct (`veo-3.1-fast-generate-preview`) |
| 15 | `veo-3.1-fast-audio-1080p` | Google | 1358 | Direct |
| 16 to 20 | `veo-3-fast-audio`, `grok-imagine-video-720p`, `sora-2`, `wan2.7-t2v`, `veo-3-audio` | | 1348 to 1340 | Veo 3 ids are deprecated; the rest direct |

### 1.2 Arena image-to-video (arena.ai/leaderboard/image-to-video, last updated 2026-09-14, 2,013,261 votes, 48 models)

| Rank | Model (as listed) | Org | Score | Public API |
|---|---|---|---|---|
| 1 | `minimax-h3` | MiniMax | 1494 | Direct plus fal; open weights |
| 2 | `gemini-omni-1.1-flash` | Google | 1488 | Direct |
| 3 | `wan3.0` | Alibaba | 1479 | Direct |
| 4 | `dreamina-seedance-2.5-720p` | ByteDance | 1475 | Direct (BytePlus) |
| 5 | `dreamina-seedance-2.0-720p` | ByteDance | 1474 | Direct plus aggregators |
| 6 | `gemini-omni-flash` | Google | 1464 | Direct (preview, deprecating) |
| 7 | `grok-imagine-video-1.5-720p` | SpaceXAI (xAI) | 1456 | Direct |
| 8 | `hidream-o1-video-1.0` | HiDream | 1452 | UNVERIFIED (announced 2026-09-17; Artificial Analysis lists an API price so some endpoint exists) |
| 9 | `flux-3-video-20260811` | Black Forest Labs | 1450 | Direct (BFL API) |
| 10 | `happyhorse-1.0` | Alibaba-ATH | 1442 | Direct plus fal |
| 11 | `wan2.7-i2v` | Alibaba | 1426 | Direct |
| 12 | `grok-imagine-video-720p` | SpaceXAI (xAI) | 1415 | Direct (`grok-imagine-video`) |
| 13 | `veo-3.1-audio` | Google | 1398 | Direct |
| 14 | `veo-3.1-audio-1080p` | Google | 1390 | Direct |
| 15 | `veo-3.1-fast-audio` | Google | 1385 | Direct |
| 16 to 20 | `grok-imagine-video-480p`, `veo-3.1-fast-audio-1080p`, `vidu-q3-pro`, `kling-v3-pro`, `veo-3-audio` | | 1385 to 1331 | All direct (Vidu: platform.vidu.com; Kling: Kling Open Platform) |

Note: Arena lists xAI as "SpaceXAI"; x.ai's own pages now carry the SpaceXAI brand too (https://x.ai/news/grok-imagine-video-1-5).

### 1.3 Artificial Analysis text-to-video (artificialanalysis.ai/video/leaderboard/text-to-video)

| Rank | Model | Creator | Elo | Released | API price (AA) | Public API |
|---|---|---|---|---|---|---|
| 1 | Gemini Omni Flash | Google | 1233 | May 2026 | $6.00/min | Direct |
| 2 | Wan 3.0 | Alibaba | 1229 | Aug 2026 | $12.00/min | Direct |
| 3 | Minimax H3 Max (post-trained by fal) | Fal | 1227 | Aug 2026 | $2.40/min | fal, and MiniMax platform lists `MiniMax-H3-Max` |
| 4 | MiniMax H3 | MiniMax | 1220 | Jul 2026 | $7.80/min | Direct |
| 5 | Dreamina Seedance 2.0 720p | ByteDance Seed | 1210 | Mar 2026 | $9.07/min | Direct (BytePlus) |
| 6 | MAGI-2 Preview (0912) | Sand.ai | 1156 | Sep 2026 | "Coming soon" | None yet (open weights, 114B MoE) |
| 7 | Wan2.7-260612 | Alibaba | 1149 | Jun 2026 | $9.00/min | Direct |
| 8 | HappyHorse-1.1 | Alibaba-ATH | 1147 | Jun 2026 | $9.90/min | Direct plus fal |
| 9 | HappyHorse-1.0 | Alibaba-ATH | 1119 | Apr 2026 | $13.20/min | Direct plus fal |
| 10 | Wan 2.7 | Alibaba | 1098 | Apr 2026 | $9.00/min | Direct |
| 11 | SkyReels V4 | Skywork AI | 1095 | Mar 2026 | $21.00/min | Aggregator (Runware); direct UNVERIFIED |
| 12 | Kling 3.0 1080p (Pro) | KlingAI | 1095 | Feb 2026 | $20.16/min | Direct |
| 13 | Kling 3.0 720p (Standard) | KlingAI | 1089 | Feb 2026 | $15.12/min | Direct |
| 14 | Veo 3.1 | Google | 1088 | Jan 2026 | $24.00/min | Direct |
| 15 | Veo 3.1 Fast | Google | 1085 | Jan 2026 | $9.00/min | Direct |
| 16 to 20 | Veo 3.1 Lite (Mar 2026, $4.80/min), Sora 2 (December) ($6.00/min, sunset), Kling 3.0 Omni 720p (Standard) ($13.44/min), Vidu Q3 Pro (Jan 2026, $9.60/min), Agnes-Video-2.5 (Sapiens AI, Aug 2026, $1.50/min, UNVERIFIED) | | | | | |

### 1.4 Artificial Analysis image-to-video, with audio (artificialanalysis.ai/video/leaderboard/image-to-video)

| Rank | Model | Creator | Elo | Released | API price (AA) | Public API |
|---|---|---|---|---|---|---|
| 1 | Minimax H3 Max (post-trained by fal) | Fal | 1195 | Aug 2026 | $2.40/min | fal (and MiniMax platform) |
| 2 | MiniMax H3 | MiniMax | 1181 | Jul 2026 | $7.80/min | Direct |
| 3 | Gemini Omni Flash | Google | 1177 | May 2026 | $6.00/min | Direct |
| 4 | HiDream-O1-Video | HiDream | 1176 | Aug 2026 | $5.80/min | UNVERIFIED |
| 5 | Dreamina Seedance 2.0 720p | ByteDance Seed | 1174 | Mar 2026 | $9.07/min | Direct |
| 6 | Wan 3.0 | Alibaba | 1164 | Aug 2026 | $12.00/min | Direct |
| 7 | HappyHorse-1.1 | Alibaba-ATH | 1106 | Jun 2026 | $9.90/min | Direct plus fal |
| 8 | grok-imagine-video-1.5 | SpaceXAI | 1099 | May 2026 | $8.40/min | Direct |
| 9 | MAGI-2 Preview | Sand.ai | 1096 | Aug 2026 | Coming soon | None yet |
| 10 | HappyHorse-1.0 | Alibaba-ATH | 1083 | Apr 2026 | $13.20/min | Direct plus fal |
| 11 | Veo 3.1 | Google | 1082 | Jan 2026 | $24.00/min | Direct |
| 12 | Wan 2.7 | Alibaba | 1078 | Apr 2026 | $9.00/min | Direct |
| 13 | PixVerse V6 | PixVerse | 1073 | Mar 2026 | $6.90/min | Direct (platform.pixverse.ai) |
| 14 | grok-imagine-video | SpaceXAI | 1073 | Jan 2026 | $4.20/min | Direct |
| 15 | SkyReels V4 | Skywork AI | 1070 | Mar 2026 | $21.00/min | Aggregator; direct UNVERIFIED |
| 16 to 20 | Veo 3.1 Lite, Veo 3.1 Fast, Vidu Q3 Pro, Kling 3.0 1080p (Pro), Kling 3.0 720p (Standard) | | 1069 to 1052 | | | All direct |

### 1.5 Release dates for the top entries

| Model | Date | Source |
|---|---|---|
| `gemini-omni-flash-preview` | API launch 2026-06-30 | https://venturebeat.com/technology/googles-gemini-omni-flash-hits-the-api-turning-enterprise-video-production-into-a-conversation |
| `gemini-omni-1.1-flash` GA | 2026-08-27 | https://mlq.ai/news/google-releases-gemini-omni-11-flash-for-controllable-ai-video-generation/ |
| Wan3.0 | public beta 2026-08-06, release 2026-08-24 (Alibaba Cloud blog dated 2026-08-13) | https://www.alibabacloud.com/blog/wan3-0-30-second-ai-video-generation-from-any-input_603452, https://technode.com/2026/08/24/alibaba-launches-wan3-0-video-model-with-30-second-generation-and-document-input/ |
| FLUX 3 (Video, Action) | announced 2026-07-23, early access; video GA via API 2026-08-05 (UNVERIFIED) | https://venturebeat.com/technology/black-forest-labs-launches-flux-3-capable-of-generating-images-and-20-second-video-with-audio-but-in-limited-release-to-start |
| Grok Imagine Video 1.5 | 2026-06-16 (GA in API 2026-06-22 per Vercel) | https://x.ai/news/grok-imagine-video-1-5 |
| Seedance 2.5 | announced 2026-06-23, launched 2026-07-31, BytePlus enterprise API live afterwards | https://seed.bytedance.com/en/blog/one-take-creation-flexible-referencing-introducing-seedance-2-5, https://x.com/BytePlusGlobal/status/2085607384182145376 |
| Seedance 2.0 | 2026-02-12 | https://seedance2-video.com/seedance-2-0-release-notes (secondary) |
| MiniMax H3 | 2026-07-31; H3-Base weights 2026-08-02/03 | https://www.marktechpost.com/2026/08/01/minimax-releases-minimax-h3-an-omni-modal-video-model-that-generates-15-second-2k-clips-with-native-stereo-audio/ |
| H3 Max (fal) | 2026-08-27 | https://blog.fal.ai/introducing-h3-max-by-fal/ |
| Muse Video (Meta) | previewed 2026-07-07, no API | https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/ |
| HappyHorse-1.1 | Jun 2026 (AA) | https://www.explainx.ai/blog/happyhorse-1-1-alibaba-video-generation-model-2026 |
| HiDream-O1-Video-1.0 | announced 2026-09-17 | https://www.media-outreach.com/news/china/2026/09/17/488140/hidream-unveils-hidream-o1-video-1-0-a-native-omnimodal-video-model-built-for-physical-consistency/ |
| MAGI-2 Preview | 2026-08-05 | https://sand.ai/blog/magi-2-preview |
| Kling 3.0 | Feb 2026; Kling 3.0 Turbo 2026-06-17 | https://www.atlascloud.ai/blog/tips/kling-3.0-turbo-kling-omni |
| Veo 3.1 | Oct 2025; Ingredients/1080p update Jan 2026; Veo 3.1 Lite Mar 2026 | https://cloud.google.com/blog/products/ai-machine-learning/veo-3-1-lite-and-a-new-veo-upscaling-capability-on-vertex-ai |
| Runway Gen-4.5 | 2025-12-01; GWM-1 2025-12-11; GWM Worlds 2 2026-09-03 | https://runway.com/research/introducing-runway-gen-4.5, https://runway.com/research/introducing-runway-gwm-1, https://runway.com/research/introducing-gwm-worlds-2 |
| Luma Ray3.2 | 2026-06-09 | https://lumalabs.ai/news/introducing-ray-3-2 |
| LTX-2.3 | 2026-03-05; LTX-2.5 2026-08-11 | https://comfyui-wiki.com/en/news/2026-08-11-ltx-2-5-open-weights-release |

## 2. Major providers

Price ballpark is for a 5 s 720p clip at list price unless noted. "Direct" means the vendor runs a first-party API.

| Provider | Newest model (date) | API status | Fast tier | Native audio | V2V / extend | ~$ per 5 s | Headline latency claim |
|---|---|---|---|---|---|---|---|
| Google (Gemini Omni) | `gemini-omni-1.1-flash` (GA 2026-08-27) | Direct: Gemini API Interactions API, AI Studio, Gemini Enterprise Agent Platform | It is the fast tier; no faster variant | Yes | Edit uploaded video (<=10 s), extend 3 to 10 s up to 40 s total; no prepend | $0.50 ($0.10/s) | None published ("times vary") |
| Google (Veo) | `veo-3.1-generate-preview`, `veo-3.1-fast-generate-preview`, `veo-3.1-lite-generate-preview` (3.1 Oct 2025, Lite Mar 2026) | Direct: Gemini API + Vertex AI, long-running operation polling | Veo 3.1 Fast, Veo 3.1 Lite | Yes | Extend (3.1 and Fast only); reference images up to 3; no restyle | Veo 3.1 $2.00 ($0.40/s AA); Fast $0.75 ($0.15/s AA); Lite $0.40 ($0.08/s AA) | Docs: "Min: 11 seconds; Max: 6 minutes (during peak hours)" |
| OpenAI Sora | `sora-2`, `sora-2-pro` (Dec 2025 snapshot) | Direct until 2026-09-24, then removed | none | Yes | Remix/extend existed | n/a | n/a |
| Runway | Gen-4.5 (2025-12-01); Aleph 2.0 (V2V); Act-Two; GWM-1 (2025-12-11); GWM Worlds 2 (2026-09-03, no API) | Direct: dev.runwayml.com (also hosts Veo 3.1 etc.) | `gen4_turbo` ("near-real-time" marketing) | Gen-4.5: UNVERIFIED (Runway audio is a separate synthesis product) | Aleph 2.0 restyle ($0.28/s); Act-Two performance transfer | Gen-4.5 $0.60 ($0.12/s) | Gen-4.5 30 to 90 s typical (third-party); no first-party number |
| Kling (Kuaishou) | Kling 3.0 (Feb 2026), Kling 3.0 Omni, Kling 3.0 Turbo (2026-06-17), Kling 3.0 Motion Control | Direct: Kling Open Platform (app.klingai.com/global/dev); also Alibaba Model Studio, fal, Replicate | Kling 3.0 Turbo (¥0.8/s 720p ≈ $0.11/s, ¥1/s 1080p) | Yes (Turbo: 5-language lip-sync) | Omni Edit V2V (reference/transform); multi-shot up to 6 | Turbo ~$0.55; Pro 1080p $1.68 ($20.16/min AA) | fal measured Kling V3 Turbo Pro: 60.7 s for 5 s 1080p |
| MiniMax | `MiniMax-H3` (2026-07-31), `MiniMax-H3-Max` (with fal, 2026-08-27); Hailuo 2.3 / 2.3 Fast (2025-10-28) | Direct: platform.minimax.io (async task + poll every 10 s); fal; open weights H3-Base | H3 Max, H3 Max Turbo (fal), Hailuo 2.3 Fast | Yes (stereo) | Reference generation (images/videos/audio), video editing, 2K regenerate; extend UNVERIFIED | H3 768p $0.40 ($0.08/s), 2K $0.65 ($0.13/s); H3 Max $0.40 ($0.08/s), Turbo $0.20 ($0.04/s) | H3 Max "5-second video in under 3 seconds" (fal) |
| ByteDance Seedance | Seedance 2.5 (2026-07-31), 2.0 / 2.0 fast / 2.0 mini (Feb to Apr 2026) | Direct: BytePlus ModelArk (`dreamina-seedance-2-5-260628`, `Dreamina Seedance 2.0 fast/mini`); fal, Replicate, OpenRouter | Seedance 2.0 fast, 2.0 mini | Yes | Timestamp-level editing, green screen, multi-round extension, up to 50 references (30 images, 10 videos, 10 audio) | 2.0 fast 480p $0.20 ($0.04/s); 2.0 720p ~$0.76 ($9.07/min AA) | 2.0 fast "~2x faster" than 2.0; fal measured 2.0 Mini 117 s for 5 s 720p |
| Luma | Ray3.2 (2026-06-09); Ray3.14 and Ray2 Flash superseded/deprecated | Direct: platform.lumalabs.ai / Luma Agents API (credits) | Draft Mode; no named flash model any more | No (ElevenLabs integration) | Modify Video V2 (20 s, 1080p), up to 16 keyframes, Reframe, Expressive Facial | ~$1.20 for 5 s 1080p SDR; 720p 100 credits | None published |
| xAI Grok Imagine | `grok-imagine-video-1.5` (2026-06-16; GA in API 2026-06-22); `grok-imagine-video` (Jan 2026) | Direct: xAI API async + poll; Vercel AI Gateway, fal, Replicate, OpenRouter | "Video 1.5 Fast" is a consumer-surface mode (UNVERIFIED as API flag) | Yes | "Video editing and extension" and references listed in docs | $0.70 ($0.14/s 720p; $0.08/s 480p; $0.25/s 1080p) | Fast: "6-second, 720p videos in about 25 seconds" |
| Alibaba Wan | Wan3.0 (`wan3.0-video`, 2026-08-24), Wan2.7 (Apr/Jun 2026), open Wan2.2; Wan-Streamer v0.3 (research) | Direct: Alibaba Cloud Model Studio (API "preview" per TechNode) and Qwen Cloud; open weights on aggregators | No first-party turbo for 3.0 (UNVERIFIED) | Yes | Reference-to-video, video editing, extension; document input | $0.50 ($0.10/s 720p; $0.05/s 480p; $0.20/s 1080p) | None published |
| Alibaba-ATH HappyHorse | HappyHorse-1.1 (Jun 2026) | Direct: Alibaba Cloud Model Studio; fal | none | Yes (multilingual lip-sync) | T2V, I2V, 9-image reference, video editing | ~$0.83 ($9.90/min AA) | none |
| Tencent Hunyuan | HunyuanVideo-1.5 (2025-11-21, 8.3B open weights); HY-World 1.5 / WorldPlay (2025-12-17); GameCraft 1.0 (Aug 2025); HunyuanWorld 2.0 (Apr 2026) | Open weights; aggregators (fal, Replicate); Tencent Cloud API mainly China, UNVERIFIED globally | step-distilled 480p I2V (8 to 12 steps) | No (1.5) | I2V, Avatar, Custom variants | aggregator pricing | none |
| Lightricks LTX | LTX-2.5 Fast/Pro (2026-08-11, 22B open weights), LTX-2.3 Fast/Pro (2026-03-05) | Direct: docs.ltx.io (sync single HTTP call or async); open weights; fal, Runware | LTX-2.x Fast (~$0.04/s for 2.3 Fast) | Yes | Retake, Extend, Reframe (Pro), Audio-to-video; first-to-last frame (2.3) | 2.3 Fast ~$0.20; fal LTX-2.5 Fast $0.13/s | Lightricks: 10 s 720p I2V in 6.8 s on 2x GB200 (self-hosted); fal measured LTX-2.5 Fast 75 s for 6 s 1080p |
| Pika | none of its own via API; "Pika API Club" (2026-08-05) resells Seedance 2.5, Gemini Omni 1.1 Flash, Wan 3.0, MiniMax H3 etc. | Aggregator only (dev.pika.art) | n/a | n/a | n/a | n/a | n/a |
| Vidu (Shengshu) | Vidu Q3 (Jan 2026): `Q3-pro`, `Q3-turbo`, `Q3-pro-fast`, `Q3-mix` | Direct: platform.vidu.com | Q3-turbo ($0.035 to $0.065/s), Q3-pro-fast | Yes | Start-end frame, reference-to-video (Q3-mix), extension, lip sync, motion sync; 1 to 16 s | Pro 720p $0.50; Turbo 720p $0.28 | none published |
| Meta | Muse Video (preview 2026-07-07) | None; Meta Model API (dev.meta.ai) exposes Muse Spark, Muse Image, Voice, SAM, not video | n/a | Yes | n/a | n/a | n/a |
| Midjourney | V8.1 default 2026-06-10 with I2V extendable to 21 s | None (no official API; ToS bans automation) | n/a | UNVERIFIED | Extend | n/a | n/a |
| Adobe Firefly | Firefly Video Model (5 s, 1080p, 4K in development) | Direct but enterprise-contract only: Firefly Services `generateVideoV3` | none | UNVERIFIED | I2V, prompt-based editing | n/a | none |
| Genmo | Mochi 1 preview (Oct 2024), no successor | Open weights; Replicate etc. | none | No | none | n/a | legacy |
| Haiper | Shut down consumer app Feb 2025; founders to Microsoft AI; models sold to NetMind.AI | None | n/a | n/a | n/a | n/a | n/a |
| Decart | Lucy 2.5 (realtime and async), Lucy Restyle 2, Lucy VTON 3.5, Oasis 3 Preview, Lucy Image 2 | Direct: platform.decart.ai (WebRTC realtime, REST async, gRPC for Oasis); also fal `decart/lucy-2-5/realtime` | Realtime is the product | No | Live V2V restyle/edit is the product | Realtime $0.02 per active second; async $0.04/s | "sub-40ms latency at 30 FPS" |
| Odyssey | Odyssey-2 Pro (2026-01-23) | Direct: developer.odyssey.ml, JS and Python SDKs; interactive streams, viewable streams, simulations | Realtime is the product | UNVERIFIED | Interactive world video | UNVERIFIED | 720p at 22 fps (Pro); 20 fps / 50 ms per frame (Odyssey-2) |
| Krea | Krea Realtime 14B (open weights, Wan 2.1 distill); app real-time video | REST aggregator API (async jobs); no public realtime video API found (UNVERIFIED) | n/a | No | Real-time restyle in app | n/a | 11 fps on one B200, first frame ~1 s |
| Higgsfield | DoP I2V (Mar 2025) plus aggregator of 50+ models | Self-serve API, mostly third-party models | n/a | n/a | n/a | n/a | n/a |
| Moonvalley | Marey Realism v1.5 | fal only (fal.ai/models/moonvalley/marey) | none | No | Pose transfer, inpainting, camera control | n/a | none |
| Stability | Stable Video Diffusion / Stable Video 4D; nothing new in 2026 | Legacy | none | No | none | n/a | legacy |
| Black Forest Labs | FLUX 3 Video (2026-07-23, 20 s with audio) | Direct BFL API (GA 2026-08-05 UNVERIFIED) and partners | none | Yes (optional) | UNVERIFIED | UNVERIFIED | none |

### Verdict

Major for a client library (first-party API, top-20 on at least one leaderboard, distinct wire protocol worth an adapter):

1. Google: `gemini-omni-1.1-flash` (Interactions API) and Veo 3.1 (generateContent LRO). One provider package, two model families.
2. MiniMax: `MiniMax-H3`, `MiniMax-H3-Max`, Hailuo 2.3 / 2.3 Fast (async task API).
3. ByteDance Seedance via BytePlus ModelArk (2.5, 2.0, 2.0 fast, 2.0 mini).
4. Alibaba Wan via Model Studio (Wan3.0, Wan2.7, plus HappyHorse-1.1 on the same platform).
5. Kling (Kuaishou) Open Platform (3.0, 3.0 Omni, 3.0 Turbo, Motion Control).
6. xAI Grok Imagine (`grok-imagine-video-1.5`).
7. Runway (Gen-4.5, Aleph 2.0, Act-Two, Characters realtime).
8. fal as an aggregator that also owns models (`H3 Max`, `H3 Max Turbo`, `H3 Max Director`) and hosts Decart realtime; if only one aggregator is supported it should be fal.

Second tier, worth an adapter if cheap: Luma Ray3.2, Lightricks LTX (open weights plus direct API), Vidu Q3, Black Forest Labs FLUX 3 Video, Decart (realtime only), Odyssey (realtime only).

Niche or out: Sora (dead in 5 days), Meta Muse Video (no API), Midjourney (no API), Adobe Firefly (enterprise contract), Pika (aggregator), Genmo, Haiper, Stability, Moonvalley (fal-only), Higgsfield and Krea (aggregators), Tencent Hunyuan (open weights; no confirmed global first-party API), HiDream, Sand.ai MAGI-2, SkyReels, PixVerse (real but small).

## 3. Speed tier

Latency numbers are for one clip unless noted. "fal measured" = fal's own test on 2026-09-09 (https://fal.ai/learn/tools/fastest-ai-video-generation-models), 9:16 vertical, same prompt.

| Model | Vendor / host | Seconds per clip | Clip | Price | Source of the number |
|---|---|---|---|---|---|
| `H3 Max Turbo` | fal (post-trained MiniMax H3) | 1.61 s | 5 s 768p | $0.04/s | fal measured |
| `H3 Max` | fal (also `MiniMax-H3-Max` on MiniMax platform) | 2.82 s measured; "under 3 seconds" claimed | 5 s 768p | $0.08/s ($2.40/min AA) | fal measured; https://blog.fal.ai/introducing-h3-max-by-fal/ |
| `H3 Max Director` | fal, WebRTC | continuous, "faster than real time"; segments 5 to 15 s | 480p/768p 24 fps | $0.08/s, $4.80 minimum per session | https://fal.ai/h3-max-director |
| `MiniMax-H3` official | MiniMax | fal claims H3 Max has "roughly 35x the throughput of the official MiniMax H3 endpoint"; self-hosted H3-Base with vLLM-Omni/FastH3 "10.1-second video-and-audio MP4 in about 8.7 seconds" (UNVERIFIED, orcarouter blog) | | $0.08/s 768P, $0.13/s 2K | https://fal.ai/minimax-h3-max, https://www.orcarouter.ai/blog/minimax-h3-hailuo-3-explained |
| Hailuo 2.3 Fast | MiniMax | "30 to 50% faster than the standard model"; no seconds published | 6 to 10 s | up to 50% cheaper than 2.3 | https://www.minimax.io/news/minimax-hailuo-23, https://www.atlascloud.ai/models/minimax/hailuo-2.3/fast |
| Grok Imagine Video 1.5 Fast | xAI (consumer surface) | ~25 s (down from 40+ s) | 6 s 720p | API: $0.08/s 480p, $0.14/s 720p, $0.25/s 1080p | https://x.ai/news/grok-imagine-video-1-5; API "typically takes up to several minutes" per https://news.creeta.com/en/grok-imagine-video-1-5-release-2026/ |
| Kling 3.0 Turbo (`Kling V3 Turbo Pro` on fal) | Kuaishou | 60.72 s | 5 s 1080p | ¥0.8/s 720p (≈$0.11/s), ¥1/s 1080p; fal $0.14/s | fal measured; https://www.atlascloud.ai/blog/tips/kling-3.0-turbo-kling-omni |
| Veo 3.1 Fast | Google | 1 min 13 s vs 2 min 41 s for Veo 3.1 (apiyi test); "roughly 90-second" (dev.to); official "Min: 11 seconds; Max: 6 minutes" | 8 s 720p | $0.15/s with audio ($9.00/min AA); $0.10/s quoted elsewhere | https://help.apiyi.com/en/veo-3-1-fast-vs-standard-complete-comparison-2026-en.html, https://ai.google.dev/gemini-api/docs/veo |
| Veo 3.1 Lite | Google | "60 to 90 seconds" (third party, UNVERIFIED) | | $0.08/s ($4.80/min AA); $0.03/s no-audio quoted | https://www.mindstudio.ai/blog/veo-3-1-vs-veo-3-1-fast-vs-veo-3-1-light-comparison |
| Gemini Omni 1.1 Flash | Google | none published | 3 to 10 s | $0.10/s ($6.00/min AA) | https://ai.google.dev/gemini-api/docs/omni |
| Seedance 2.0 fast | ByteDance / BytePlus | "~2x faster" than 2.0 (which is reported 60 to 120 s for 5 s); "under 2 minutes" | | $0.04035/s 480p (OpenRouter) | https://openrouter.ai/bytedance/seedance-2.0-fast, https://wavespeed.ai/blog/video-model-access/seedance-mini-vs-fast-api/ |
| Seedance 2.0 mini | ByteDance | 117.32 s | 5 s 720p | ~$0.1547/s (fal) | fal measured |
| LTX-2.5 Fast | Lightricks | 75.17 s on fal (6 s 1080p); Lightricks claim 10 s 720p I2V in 6.8 s on two GB200 (self-hosted) | | fal $0.13/s; LTX-2.3 Fast ~$0.04/s on Lightricks API | fal measured; https://cryptobriefing.com/ltx-2-5-ai-video-model-release/ |
| Runway `gen4_turbo` | Runway | "near-real-time generation at 1080p" (marketing only); Gen-4.5 30 to 90 s typical (third party) | | Gen-4.5 $0.12/s; gen4_turbo cheaper, exact UNVERIFIED | https://aitoolsdevpro.com/ai-tools/runway-guide/, https://openrouter.ai/runway/gen-4.5 |
| Luma Ray2 Flash / Ray3.14 | Luma | Ray3.14 marketed "4x faster"; both superseded by Ray3.2 which has "Draft Mode" | | | https://lumalabs.ai/llm-info |
| Vidu Q3-turbo | Shengshu | none published | 1 to 16 s | $0.035/s 540p to $0.065/s 1080p | https://platform.vidu.com/docs/pricing |
| Wan turbo | Alibaba | no first-party turbo for Wan3.0/2.7 found (UNVERIFIED); aggregators sell Wan2.2 "turbo" open-weight distills | | Wan3.0 $0.05/s 480p | https://www.alibabacloud.com/blog/wan3-0-30-second-ai-video-generation-from-any-input_603452 |

Artificial Analysis publishes "API Generation Time" (median seconds for a 720p 5 s video, measured end to end over 3 days) at https://artificialanalysis.ai/video/models and per-provider at https://artificialanalysis.ai/video/providers, but the numbers are rendered in charts and did not come through the fetch. Treat those pages as the canonical source for a latency column if the plan needs one.

Takeaway: the speed tier has two bands. Band A (sub-5 s, faster than playback) is only fal's H3 Max family today. Band B (25 to 120 s) is every other "fast" SKU: Grok Fast, Kling Turbo, Veo Fast/Lite, Seedance fast/mini, LTX Fast, Hailuo 2.3 Fast. Band B is what an async "fast" flag in a common request would target; Band A is what makes a streaming or interactive API plausible.

## 4. Streaming, progressive and real-time video

### (a) Progressive delivery of one clip (partial output while the clip renders)

Status as of 2026-09-19: no major vendor's clip-generation API streams partial frames or segments of a single clip over SSE, chunked HTTP, or WebSocket. Every first-party clip API is submit-then-poll (or, for LTX, one synchronous HTTP call that returns the full file). Specifically:

| Vendor / API | Mechanism | Partial event contains | Public API |
|---|---|---|---|
| Google `gemini-omni-1.1-flash` | Interactions API; result inline base64 (<=4 MB) or `delivery="uri"` with polling until `ACTIVE` | nothing; output "is returned at completion, not streamed progressively" | Yes |
| Google Veo 3.1 | `generateContent` long-running operation, poll every ~10 s | nothing | Yes |
| MiniMax `MiniMax-H3` / `H3-Max` | create task, poll `task_id` every 10 s; "No streaming of partial video exists" | nothing | Yes |
| xAI `grok-imagine-video-1.5` | async, poll request id until `done` | nothing | Yes |
| Kling, Seedance (BytePlus), Wan (Model Studio), Vidu, Runway gen, Luma | async job + poll or webhook | nothing | Yes |
| LTX API | sync single HTTP call or async polling; no SSE/WebSocket | nothing | Yes |
| fal generic `/stream` SSE endpoints | SSE; partial events are JSON; documented example is image previews per diffusion step | fal docs list no video model that emits partial frames on `/stream` | Mechanism yes, video model UNVERIFIED (none found) |
| Sand.ai MAGI-1 / MAGI-2 | MAGI-1 is chunk-autoregressive (24-frame chunks; next chunk starts denoising before the current one finishes) so progressive chunk delivery is architecturally natural; MAGI-2 Preview API is "Coming soon" | n/a | No (open weights only) |
| ByteDance Seaweed-APT2 | 8B, 1 NFE per latent frame, 24 fps streaming at 736x416 on one H100; "streamed to the user with minimum latency" | research demo | No API |
| Lightricks LTX-2.x | model is fast enough to run "in real time" (marketing); no streaming endpoint in the LTX API | n/a | No streaming API |

The only public APIs that deliver generated video progressively do so as a continuous WebRTC media track rather than as chunks of a fixed clip. These sit between (a) and (b):

| API | Mechanism | What arrives | Public |
|---|---|---|---|
| fal `minimax/h3-max/director` (H3 Max Director, 2026-09-08) | fal WMA: WebRTC peer connection. Signaling via POST `/session` with an SDP offer (bridge at `wma.fal.run`), heartbeat POST every 5 s, then media flows peer to peer. Client sends JSON on a data channel (`{"prompt": ...}` updates `session_params` in place); receives live video and stereo audio tracks. Must be opened with the realtime client, not `fal.run`/`fal.subscribe`/queue | Continuous 24 fps video at 480p or 768p plus 48 kHz stereo audio; generated in 5 to 15 s segments (10 s default) with 12-segment context memory (up to 50); autoregressive, single continuous stream | Yes, production. $0.08/s, $4.80 minimum (60 s). Consumer showcase: fal.live "H3 Max Live" channels |
| Odyssey-2 Pro "viewable streams" | WebRTC media plus WebSocket signaling (per third-party API catalogue; UNVERIFIED against Odyssey docs which do not state the transport) | one generated stream broadcast to many viewers | Yes |

Sources: https://fal.ai/h3-max-director, https://fal.ai/models/minimax/h3-max/director/api, https://fal.ai/docs/documentation/development/wma, https://fal.ai/docs/documentation/development/streaming, https://ai.google.dev/gemini-api/docs/omni, https://platform.minimax.io/docs/guides/video-generation, https://docs.ltx.io/welcome, https://sand.ai/blog/magi-2-preview, https://seaweed-apt.com/2, https://www.latent.space/p/ainews-fals-h3-max-live-breaks-the.

### (b) Real-time interactive world models and live video-to-video

| System | Vendor | What it is | Transport / API | Resolution, fps, latency | Public API |
|---|---|---|---|---|---|
| Lucy 2.5 realtime (`lucy-2.5`), Lucy Restyle 2, Lucy VTON 3.5 | Decart | Live V2V editing of a camera or stream: character swap, background, restyle, try-on, VFX; prompt changeable mid-stream | WebRTC: client adds a local video track, receives a transformed video track; auto-reconnect; async REST variants for files. Also on fal at `decart/lucy-2-5/realtime` | 720p, 30 fps, "sub-40ms latency"; realtime $0.02 per active second, async $0.04/s (Restyle $0.01/s) | Yes (platform.decart.ai) |
| Oasis 3 Preview (`oasis-3-preview`) | Decart | Promptable world model: set a scene, drive with actions, get next frames | Python gRPC | 768x512; $0.02/s, enterprise pricing | Yes (preview) |
| MirageLSD | Decart | 2025 live-stream diffusion, <40 ms re-skin; predecessor of Lucy | Not on the current Decart models page; available on Crusoe Cloud | | Superseded |
| Odyssey-2 Pro | Odyssey | General-purpose world model; "interactive streams" (per-user, programmatic actions), "viewable streams", "simulations" (batch, actions at time steps) | JS and Python SDKs; `ody_` API key mints short-lived session JWTs for browsers; WebRTC media plus WebSocket signaling (UNVERIFIED) | 720p at 22 fps; Odyssey-2 produced a frame every 50 ms (20 fps) | Yes (developer.odyssey.ml, since 2026-01-23); pricing UNVERIFIED |
| Runway Characters (GWM-1 Avatars) | Runway | Real-time conversational avatar from one image | WebRTC sessions, max 5 min, single-use credentials; React SDK `avatars-sdk-react` | 720p | Yes (dev.runwayml.com) |
| Runway GWM Worlds 2 | Runway | Interactive worlds: text actions, continuous camera motion, key/mouse bindings; generated audio | Web research preview only | 720p, 24 fps, 48 kHz audio | No API |
| Runway GWM Robotics | Runway | Synthetic data / policy evaluation | Python SDK via developer portal | | Yes (SDK) |
| Genie 3 / Project Genie | Google DeepMind | Text or image to explorable world | Web app for Google AI Ultra subscribers, US only, 18+ | 24 fps, minutes of consistency | No API, no date |
| Krea Realtime 14B | Krea | Autoregressive T2V/V2V distilled from Wan 2.1 14B with Self-Forcing; prompt changes mid-generation | Open weights (license reported both as Apache 2.0 and CC BY-NC-SA 4.0, UNVERIFIED) plus a self-host WebSocket streaming server; Krea's hosted REST API is async jobs only | 11 fps at 4 steps on one B200; first frame ~1 s | Self-host only; no public realtime endpoint found |
| StreamDiffusionV2 | open source (chenfengxu714) | Training-free streaming pipeline over Self-Forcing Wan2.1 1.3B/14B; rolling KV cache, SLO-aware batching | Hosted by Daydream (Livepeer): WebRTC/WHIP ingest and output; Scope local server on `localhost:8000` with WebRTC API; API key "currently subsidized", pricing TBA | 58 fps (14B) / 64 fps (1.3B) on 4x H100; first frame 0.5 s; ~20 GB VRAM at 832x480 | Yes via Daydream (pricing not public) |
| Self-Forcing | research (Adobe Research et al.) | Technique converting bidirectional video diffusion into autoregressive streaming models | Underlies Krea Realtime 14B and StreamDiffusionV2 | | Not a product |
| Wan-Streamer v0.1 to v0.3 | Alibaba | Full-duplex audio-visual conversational model: one Transformer listens, sees, speaks and renders video | Open weights, Apache 2.0, Hugging Face (Jul 2026) | 640x368 at 25 fps, ~200 ms model-side latency (v0.2) | No hosted API |
| Alibaba LiveAvatar | Alibaba Quark | Streaming real-time audio-driven avatar, infinite length (ECCV 2026) | Open source | | No hosted API |
| Hunyuan-GameCraft 1.0 | Tencent | Interactive game video from one image plus WASD | Open weights (Aug 2025) | 6.6 fps real-time, 720p, 25 fps internal | No hosted API |
| HY-World 1.5 / WorldPlay (5B, 8B) | Tencent | Real-time interactive world model with long-term geometric consistency, keyboard/mouse | Open weights (2025-12-17), training and RL code | 24 fps | No hosted API |
| Seaweed-APT2 | ByteDance | Real-time interactive streaming generation, pose-controlled virtual humans | Demo | 24 fps at 736x416 on one H100; 1280x720 on 8x H100 | No API |
| HiDream-O1-World | HiDream | Interactive world model (roaming, editing, interaction), tops WBench | Announced 2026-08-24 | | UNVERIFIED |
| fal H3 Max Director | fal | Prompt-directed continuous generation (listed in (a) above) | WebRTC (WMA) | 24 fps | Yes |

Sources: https://docs.platform.decart.ai/models/realtime/lucy-2.5, https://docs.platform.decart.ai/getting-started/models, https://docs.platform.decart.ai/getting-started/pricing, https://odyssey.systems/the-gpt-2-moment-for-world-models, https://documentation.api.odyssey.ml/, https://docs.dev.runwayml.com/characters/concepts/, https://runway.com/research/introducing-gwm-worlds-2, https://runway.com/research/introducing-runway-gwm-1, https://deepmind.google/models/genie/, https://www.krea.ai/blog/krea-realtime-14b, https://github.com/krea-ai/realtime-video, https://arxiv.org/abs/2511.07399, https://docs.daydream.live/api/quickstart, https://huggingface.co/papers/2607.04443, https://github.com/Tencent-Hunyuan/HY-WorldPlay, https://github.com/Tencent-Hunyuan/Hunyuan-GameCraft-1.0, https://seaweed-apt.com/2.

### (c) Just fast async

Everything in section 3 except the H3 Max Director row: Veo 3.1 Fast/Lite, Gemini Omni Flash, Hailuo 2.3 Fast, H3 Max / H3 Max Turbo (fast but still a whole-file response), Seedance 2.0 fast/mini, Kling 3.0 Turbo, LTX-2.x Fast, Grok Imagine Video 1.5 (Fast), Vidu Q3-turbo, Runway gen4_turbo.

Design implication: a `VideoGenerator` capability needs (1) an async job model with polling and webhooks as the universal path, (2) an optional "fast" preference, and (3) a separate realtime session abstraction (WebRTC tracks plus a data channel for prompts/actions) for fal WMA, Decart, Odyssey and Runway Characters. There is nothing to model as "SSE stream of a clip" today.

## 5. MiniMax specifics

What the user probably remembers as "H3 Max" / "Hailuo 3 Max":

- `MiniMax H3` is the official name of the model MiniMax released 2026-07-31; "Hailuo 3.0" and "Hailuo 03" are aliases (https://huggingface.co/blog/ResterChed/minimax-h3-hailuo-3-0). Omni-modal (text, image, video, audio in), 4 to 15 s, up to 2K, native stereo audio, multi-shot. API ids on platform.minimax.io: `MiniMax-H3` (768P, 2K; $0.08/s and $0.13/s) and `MiniMax-H3-Max` (480P, 768P, 5 to 15 s, "optimized for faster generation"). Open weights `H3-Base` (33B) since 2026-08-02/03 under the MiniMax H3 Community License (weights excluded for EU/UK/KR/US; orgs over $20M revenue need authorization; Context-IR and 2K regenerate stay API-side).
- `H3 Max` is fal Research's post-train of H3-Base, released 2026-08-27, "generates a 5-second video in under 3 seconds", ~35x the throughput of the official H3 endpoint, #1 on Artificial Analysis image-to-video and #3 text-to-video. 5 to 15 s at 480p or 768p, 24 fps, stereo audio; endpoints for text-to-video, image-to-video (doubles as first-to-last frame), reference-to-video (up to 12 files). MiniMax's own docs describe it as "jointly released by MiniMax and fal.ai". `H3 Max Turbo` is the cheaper, 1.6 s variant ($0.04/s).
- Streaming: the base `H3 Max` and `MiniMax-H3` endpoints do not stream; both are submit-and-poll and return a whole file. The streaming product is `H3 Max Director` (fal, 2026-09-08, endpoint `minimax/h3-max/director`): a natively continuous autoregressive variant that generates one unbroken stream, accepts live prompts over a WebRTC data channel, keeps up to two minutes of context, and is the engine behind fal.live's "H3 Max Live" channels (the "infinite broadcast" demos, "Type !prompt and it's on screen in seconds"). That is almost certainly the "fast streaming MiniMax model" the user has in mind.
- There is no model literally called "Hailuo 3 Max"; the closest official strings are `MiniMax-H3-Max` (MiniMax platform) and `H3 Max` (fal). Older names: `MiniMax-Hailuo-2.3` and `Hailuo 2.3 Fast` (2025-10-28), Hailuo 02 (2025).

Sources: https://platform.minimax.io/docs/guides/video-generation, https://blog.fal.ai/introducing-h3-max-by-fal/, https://fal.ai/minimax-h3-max, https://fal.ai/h3-max-director, https://x.com/fal/status/2095599871449342288, https://www.latent.space/p/ainews-fals-h3-max-live-breaks-the, https://www.minimax.io/news/minimax-hailuo-23.

## 6. Modalities beyond text-to-video

Y = documented, N = documented absent, U = UNVERIFIED. "Ref" = subject/reference-to-video with multiple images. "Lipsync" = a dedicated audio-driven lip-sync or talking-head mode (all "native audio" models also produce dialogue).

| Provider / model | T2V | I2V first frame | First + last | Ref (multi-image) | V2V restyle/edit | Extend | Lipsync / talking head | Camera control | Native audio with dialogue |
|---|---|---|---|---|---|---|---|---|---|
| Google `gemini-omni-1.1-flash` | Y | Y | Y (GA added interpolation) | Y (multi-input reasoning; images + video) | Y (conversational edit of uploaded video <=10 s; no dialogue add on speech videos) | Y (3 to 10 s, up to 40 s) | U (dialogue generated; no dedicated mode) | prompt only | Y |
| Google Veo 3.1 / Fast | Y | Y | Y | Y (up to 3 reference images; not Lite) | N | Y (not Lite) | U | prompt only | Y |
| Kling 3.0 / Omni / Turbo | Y | Y | Y (3.0) | Y (up to 7 images, Omni) | Y (Omni Edit: reference and transform modes) | U for 3.0 (earlier Kling had extend) | Y (Turbo 5-language lip-sync; Kling lip-sync API) | Y (`kling-v3-motion-control`; camera params U for 3.0) | Y (`generate_audio`) |
| ByteDance Seedance 2.5 / 2.0 | Y | Y | Y (2.0 fast documented) | Y (2.5: 30 images, 10 videos, 10 audio) | Y (timestamp-level editing, green screen) | Y (multi-round extension) | U (multilingual dialogue; no dedicated mode) | Y (camera perspective editing) | Y |
| MiniMax `MiniMax-H3` / `H3 Max` | Y | Y | Y (H3 first/last; H3 Max via end frame) | Y (images, videos, audio; H3 Max up to 12 files) | Y (video editing) | U | U | U | Y (stereo) |
| Alibaba Wan3.0 | Y | Y | U | Y (character, prop, space, style) | Y (modify visuals, plot, dialogue) | Y | U (dialogue native) | U | Y |
| xAI `grok-imagine-video-1.5` | U (docs describe I2V as primary; T2V via still image) | Y | U | Y (text, image, voice references, 1080p) | Y ("video editing and extension") | Y | U | U | Y |
| Runway Gen-4.5 + Aleph 2.0 + Act-Two | Y | Y | U | U | Y (Aleph 2.0) | U | Y (Act-Two; Characters realtime) | prompt only | U (Gen-4.5 audio not confirmed native) |
| Luma Ray3.2 | Y | Y | Y (up to 16 keyframes) | U | Y (Modify Video V2, 20 s 1080p) | Y (keyframe-based) | Y (Expressive Facial, up to 8 faces; Motion Transfer) | Y (reframe; camera via prompt/keyframes) | N (ElevenLabs integration) |
| Lightricks LTX-2.5 / 2.3 | Y | Y | Y (2.3 first-to-last) | U | Y (Retake, Reframe; Pro) | Y (Extend; Pro) | Y (Audio-to-video) | U | Y |
| Vidu Q3 | Y | Y | Y (start-end) | Y (`Q3-mix`) | N found | Y (Video Extension) | Y (Lip Sync, Motion Sync) | U | Y |
| Alibaba-ATH HappyHorse-1.1 | Y | Y | U | Y (9 images) | Y (video editing) | U | Y (multilingual lip-sync) | U | Y |
| Black Forest Labs FLUX 3 Video | Y | Y | U | U | U | U | U | U | Y (optional) |
| Decart Lucy 2.5 | N | N | N | Y (reference image for edits) | Y (live and async) | n/a | N | N | N |

Sources: https://ai.google.dev/gemini-api/docs/omni, https://ai.google.dev/gemini-api/docs/veo, https://replicate.com/kwaivgi/kling-v3-omni-video, https://replicate.com/kwaivgi/kling-v3-motion-control, https://seed.bytedance.com/en/blog/one-take-creation-flexible-referencing-introducing-seedance-2-5, https://openrouter.ai/bytedance/seedance-2.0-fast, https://platform.minimax.io/docs/guides/video-generation, https://fal.ai/minimax-h3-max, https://www.alibabacloud.com/blog/wan3-0-30-second-ai-video-generation-from-any-input_603452, https://docs.x.ai/docs/guides/video-generation, https://lumalabs.ai/llm-info, https://docs.ltx.io/models, https://platform.vidu.com/docs/pricing, https://www.explainx.ai/blog/happyhorse-1-1-alibaba-video-generation-model-2026.

## 7. Video understanding in LLMs

Gemini is the only major LLM API with first-class video input: files go through the Files API (or inline under 100 MB), and the model can describe, segment, answer questions and cite timestamps; "agentic video understanding" (Gemini 3.7 Flash, 3.6 Flash, 3.5 Flash-Lite) scans segments dynamically to cut tokens (https://ai.google.dev/gemini-api/docs/video-understanding, https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-agentic-video-in-gemini/). `gemini-omni-1.1-flash` also accepts video as an input to editing and extension. Live video also exists via the Gemini Live API (used by Gemini Robotics ER 2). Claude does not accept video: the vision docs list only `image/jpeg`, `image/png`, `image/gif`, `image/webp`, and "Animations are unsupported, and only the first frame is used" (https://platform.claude.com/docs/en/build-with-claude/vision). A third-party post claiming an Anthropic "real-time video API" in June 2026 (aidailyshot.com) is not reflected in the official docs; treat it as false. OpenAI's Responses API has no native video input either; the official guidance is still frame extraction with ffmpeg into an image array (https://github.com/openai/openai-node/issues/1778, https://developers.openai.com/cookbook/examples/gpt_with_vision_for_video_understanding). xAI: the docs overview advertises "text, voice, image, and video capabilities", but the video pages found are generation only and the `video-understanding` guide URL returns 404, so video input to Grok chat is UNVERIFIED (https://docs.x.ai/overview).

For the plan: video understanding belongs in the existing LLM/generation capability as a content part on providers that support it (Gemini today, with a `video` part backed by a file upload), not in `VideoGenerator`. The one crossover is Gemini Omni, where the same Interactions API call takes a video in and returns an edited video out; that is a `VideoGenerator` edit/extend operation, not understanding.

## Sources

Leaderboards
- https://arena.ai/leaderboard/text-to-video
- https://arena.ai/leaderboard/image-to-video
- https://artificialanalysis.ai/video/leaderboard/text-to-video
- https://artificialanalysis.ai/video/leaderboard/image-to-video
- https://artificialanalysis.ai/video/models
- https://artificialanalysis.ai/video/methodology

Google
- https://ai.google.dev/gemini-api/docs/video
- https://ai.google.dev/gemini-api/docs/omni
- https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash
- https://ai.google.dev/gemini-api/docs/veo
- https://ai.google.dev/gemini-api/docs/video-understanding
- https://venturebeat.com/technology/googles-gemini-omni-flash-hits-the-api-turning-enterprise-video-production-into-a-conversation
- https://mlq.ai/news/google-releases-gemini-omni-11-flash-for-controllable-ai-video-generation/
- https://cloud.google.com/blog/products/ai-machine-learning/veo-3-1-lite-and-a-new-veo-upscaling-capability-on-vertex-ai
- https://help.apiyi.com/en/veo-3-1-fast-vs-standard-complete-comparison-2026-en.html
- https://deepmind.google/models/genie/
- https://en.wikipedia.org/wiki/Project_Genie_(website)

OpenAI
- https://developers.openai.com/api/docs/deprecations
- https://help.openai.com/en/articles/20001152-what-to-know-about-the-sora-discontinuation
- https://the-decoder.com/openai-sets-two-stage-sora-shutdown-with-app-closing-april-2026-and-api-following-in-september/
- https://github.com/openai/openai-node/issues/1778

MiniMax and fal
- https://platform.minimax.io/docs/guides/video-generation
- https://www.minimax.io/news/minimax-hailuo-23
- https://huggingface.co/blog/ResterChed/minimax-h3-hailuo-3-0
- https://www.marktechpost.com/2026/08/01/minimax-releases-minimax-h3-an-omni-modal-video-model-that-generates-15-second-2k-clips-with-native-stereo-audio/
- https://blog.fal.ai/introducing-h3-max-by-fal/
- https://fal.ai/minimax-h3-max
- https://fal.ai/h3-max-director
- https://fal.ai/models/minimax/h3-max/director/api
- https://fal.ai/docs/documentation/development/wma
- https://fal.ai/docs/documentation/development/streaming
- https://fal.ai/learn/tools/fastest-ai-video-generation-models
- https://www.latent.space/p/ainews-fals-h3-max-live-breaks-the
- https://x.com/fal/status/2093844097148559588
- https://x.com/fal/status/2095599871449342288

ByteDance
- https://seed.bytedance.com/en/blog/one-take-creation-flexible-referencing-introducing-seedance-2-5
- https://x.com/BytePlusGlobal/status/2085607384182145376
- https://docs.byteplus.com/en/docs/ModelArk/1520757
- https://openrouter.ai/bytedance/seedance-2.0-fast
- https://wavespeed.ai/blog/video-model-access/seedance-mini-vs-fast-api/
- https://seaweed-apt.com/2

Alibaba
- https://www.alibabacloud.com/blog/wan3-0-30-second-ai-video-generation-from-any-input_603452
- https://technode.com/2026/08/24/alibaba-launches-wan3-0-video-model-with-30-second-generation-and-document-input/
- https://huggingface.co/papers/2607.04443
- https://www.alibabacloud.com/blog/wan-streamer-a-native-streaming-model-for-real-time-audio-visual-conversation_603376
- https://www.explainx.ai/blog/happyhorse-1-1-alibaba-video-generation-model-2026
- https://fal.ai/happyhorse-1.0
- https://github.com/Alibaba-Quark/LiveAvatar

Kling
- https://app.klingai.com/global/dev/document-api/quickStart/productIntroduction/overview
- https://www.atlascloud.ai/blog/tips/kling-3.0-turbo-kling-omni
- https://replicate.com/kwaivgi/kling-v3-omni-video
- https://replicate.com/kwaivgi/kling-v3-motion-control

xAI
- https://x.ai/news/grok-imagine-video-1-5
- https://docs.x.ai/docs/guides/video-generation
- https://docs.x.ai/overview
- https://news.creeta.com/en/grok-imagine-video-1-5-release-2026/
- https://openrouter.ai/x-ai/grok-imagine-video-1.5

Runway
- https://runway.com/research/introducing-runway-gen-4.5
- https://runway.com/research/introducing-runway-gwm-1
- https://runway.com/research/introducing-gwm-worlds-2
- https://docs.dev.runwayml.com/characters/concepts/
- https://github.com/runwayml/avatars-sdk-react
- https://openrouter.ai/runway/gen-4.5

Luma, LTX, Vidu, Pika, Adobe, Midjourney, Meta, BFL, others
- https://lumalabs.ai/llm-info
- https://lumalabs.ai/news/introducing-ray-3-2
- https://docs.ltx.io/welcome
- https://docs.ltx.io/models
- https://comfyui-wiki.com/en/news/2026-08-11-ltx-2-5-open-weights-release
- https://cryptobriefing.com/ltx-2-5-ai-video-model-release/
- https://platform.vidu.com/docs/pricing
- https://dev.pika.art/
- https://experiment.pika.art/blog/pika-api-club
- https://developer.adobe.com/audio-video-firefly-services/api/
- https://www.wireflow.ai/blog/best-midjourney-api-tools-in-2026
- https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/
- https://dev.meta.ai/docs/overview
- https://venturebeat.com/technology/black-forest-labs-launches-flux-3-capable-of-generating-images-and-20-second-video-with-audio-but-in-limited-release-to-start
- https://invideo.io/blog/flux-3-ai-video-generator/
- https://sand.ai/blog/magi-2-preview
- https://github.com/SandAI-org/MAGI-1
- https://www.media-outreach.com/news/china/2026/09/17/488140/hidream-unveils-hidream-o1-video-1-0-a-native-omnimodal-video-model-built-for-physical-consistency/
- https://pixverse.ai/en/blog/pixverse-launches-v6-advancing-ai-video-generation
- https://runware.ai/creators/skywork
- https://huggingface.co/tencent/HunyuanVideo-1.5
- https://github.com/Tencent-Hunyuan/HY-WorldPlay
- https://github.com/Tencent-Hunyuan/Hunyuan-GameCraft-1.0
- https://github.com/genmoai/mochi
- https://fluxnote.io/guides/what-happened-to-haiper-ai
- https://fal.ai/models/moonvalley/marey/i2v
- https://higgsfield.ai/higgsfield-api
- https://stability.ai/stable-video

Real-time and streaming
- https://docs.platform.decart.ai/models/realtime/lucy-2.5
- https://docs.platform.decart.ai/getting-started/models
- https://docs.platform.decart.ai/getting-started/pricing
- https://fal.ai/models/decart/lucy-2-5/realtime
- https://odyssey.systems/the-gpt-2-moment-for-world-models
- https://documentation.api.odyssey.ml/
- https://github.com/api-evangelist/odyssey/blob/main/apis.yml
- https://www.krea.ai/blog/krea-realtime-14b
- https://github.com/krea-ai/realtime-video
- https://arxiv.org/abs/2511.07399
- https://docs.daydream.live/scope/reference/pipelines/streamdiffusion-v2
- https://docs.daydream.live/api/quickstart
- https://www.morningstar.com/news/business-wire/20251106860538/daydream-launches-scope-and-expands-streamdiffusion-with-sdxl-support-advancing-the-open-source-real-time-ai-video-ecosystem

LLM video input
- https://platform.claude.com/docs/en/build-with-claude/vision
- https://ai.google.dev/gemini-api/docs/video-understanding
- https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-agentic-video-in-gemini/
- https://developers.openai.com/cookbook/examples/gpt_with_vision_for_video_understanding
