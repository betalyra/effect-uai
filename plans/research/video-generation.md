# Research: video generation

Provider survey, streaming analysis and recipe selection for the
`VideoGenerator` capability (issue #136). Primary sources (API docs,
pricing pages, vendor OpenAPI schemas) plus the Arena and Artificial
Analysis video leaderboards, 2026-09-19. Unconfirmed claims are marked
UNVERIFIED. Full subagent reports are in
[video-generation/](./video-generation/).

## Verdict up front

Three findings decide the design.

- **Progressive delivery does not exist.** No public clip-generation
  API streams partial frames or segments while the clip renders. Every
  one is submit-then-poll. So `VideoGenerator` has no
  `streamGeneration`, and there is no `VideoStreaming` marker.
- **OpenAI is out.** The Videos API and every Sora 2 id are removed on
  **2026-09-24**, five days from this writing, with no replacement
  named. Verified directly against
  [OpenAI's deprecations page](https://developers.openai.com/api/docs/deprecations):
  "notified developers using the Videos API and Sora 2 video generation
  model aliases and snapshots of their deprecation and removal from the
  API on September 24, 2026."
- **Continuous generation is real but it is a different capability.**
  fal's `minimax/h3-max/director` generates an unbroken WebRTC stream
  steered by prompts on a data channel. That is the realtime archetype,
  not the video archetype. It belongs next to `RealtimeSession`, not
  inside `VideoGenerator`.

Launch providers should be **fal** and **Google**, the two packages that
already exist, matching how image generation launched. fal alone covers
Veo, Kling, MiniMax, Seedance, Wan, LTX and Grok behind one queue
protocol; Google covers the direct path and is top of both leaderboards.

A fourth finding shapes the Google adapter specifically: **Google now has
two video paths that share almost nothing.** The video guide says
verbatim, "Use Gemini Omni Flash as your default model for video
generation... Use Veo 3.1 for specific capabilities like scene
extension, last-frame control, or integration with legacy pipelines."
Omni is `POST /v1beta/interactions` in `snake_case`, synchronous by
default and asynchronous with `background: true`; Veo is
`predictLongRunning` plus an operation poll in `camelCase`. Veo is not
deprecated (all three 3.1 ids show "No shutdown date announced"), but
Veo 3.0 and 2.0 shut down on 2026-06-30. One package, two codecs, two
operation models.

## Main providers and their models

Price is per second of output unless noted. "Fast tier" is the vendor's
own speed SKU.

| Provider           | Quality model (Arena T2V / I2V rank)     | Fast tier                                 | Price                              | API shape                                    | Native audio                    | Extend / v2v                |
| ------------------ | ---------------------------------------- | ----------------------------------------- | ---------------------------------- | -------------------------------------------- | ------------------------------- | --------------------------- |
| Google Gemini Omni | `gemini-omni-1.1-flash` (#1 / #2)        | it is the fast tier                       | ~$0.10/s, billed per token         | Interactions API, sync or `background: true` | always on, no toggle            | edit <=10 s, extend to 40 s |
| Google Veo         | `veo-3.1-generate-preview` (#12 / #13)   | `veo-3.1-fast-generate-preview`, `-lite-` | $0.40 / $0.10 / $0.05              | `predictLongRunning` + operation poll        | always on, no toggle            | extend (not Lite)           |
| Alibaba Wan        | `wan3.0` (#3 / #3)                       | none first-party                          | $0.05/s 480p                       | Model Studio task API                        | yes                             | yes                         |
| ByteDance Seedance | `dreamina-seedance-2-5-260628` (#6 / #4) | `-2-0-fast-`, `-2-0-mini`                 | token-priced, ~$0.22/s 480p on fal | ModelArk `contents/generations/tasks`        | yes (`generate_audio`)          | yes (reference task)        |
| MiniMax            | `MiniMax-H3` (#8 / #1)                   | `MiniMax-H3-Max`                          | $0.08/s 768P                       | V2 create + poll                             | yes, always on, no toggle       | video editing               |
| xAI Grok Imagine   | `grok-imagine-video-1.5` (#5 / #7)       | Fast variant                              | $0.14/s 720p                       | async poll                                   | yes                             | yes                         |
| Kling              | `kling-3.0`, `-omni` (#19 I2V)           | `kling-3.0-turbo`                         | $0.112/s 1080p, +$0.056 audio      | version in URL path, poll, webhooks          | yes (`native`/`original`/`off`) | omni edit, extend           |
| Runway             | `gen4.5`                                 | `gen4_turbo`                              | $0.12 / $0.05                      | modality picks endpoint, poll                | own models silent               | `aleph2` v2v, extend        |
| Luma               | `ray-3.2`                                | none                                      | ~$0.24/s 1080p                     | one endpoint, `type` discriminates           | none at all                     | modify, keyframes           |
| BFL                | `flux-3-video` (#4 / #9)                 | UNVERIFIED                                | UNVERIFIED                         | BFL API                                      | UNVERIFIED                      | UNVERIFIED                  |

Aggregators: **fal** hosts all of the above except Runway and Luma Ray
3, under `queue.fal.run`, and owns `H3 Max` / `H3 Max Turbo` /
`H3 Max Director` outright. **Replicate** is the only aggregator
carrying Runway and Luma Ray 3. **OpenRouter** has a clean normalised
`POST /api/v1/videos`. **Vercel AI Gateway** wraps the same job model
for the AI SDK. **Runway is itself now an aggregator**, hosting Veo,
Seedance, Wan, Hailuo, Grok and Gemini behind its own endpoints.

Not worth targeting: **OpenAI Sora** (removed in five days), **Meta Muse
Video** (no API), **Midjourney** (no API), **Adobe Firefly** (enterprise
contract), **Pika** (resells other vendors' models), **Tencent Hunyuan**
(open weights, no confirmed global API), Genmo, Haiper, Stability,
Moonvalley.

### Google's two paths in detail

Because Google is a launch provider, the split is worth stating exactly.

|                  | Gemini Omni                                                                                 | Veo 3.1                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Endpoint         | `POST /v1beta/interactions`                                                                 | `models/{id}:predictLongRunning`                                                                    |
| Operation        | synchronous by default; async with `background: true`, poll `GET /v1beta/interactions/{id}` | LRO, poll `GET {base}/{operation}` until `done`                                                     |
| Casing           | `snake_case`                                                                                | `camelCase`                                                                                         |
| Status           | GA, paid only                                                                               | all three 3.1 ids still Preview on the Gemini API; the GA ids live on the Enterprise Agent Platform |
| Duration         | prompt-driven, 3 to 10 s                                                                    | `durationSeconds` as a **string** `"4"`/`"6"`/`"8"` (integer on Vertex)                             |
| Resolution       | `360p`/`720p`/`1080p`/`4k`, upper two upscaled                                              | `720p`/`1080p`/`4k`, the upper two 8 s only                                                         |
| Output           | inline base64 (~4 MB cap) or `delivery: "uri"` plus Files API poll                          | `generatedSamples[0].video.uri`, downloaded with the API key                                        |
| Retention        | Files API 48 h; interaction record 55 d paid                                                | 2 days                                                                                              |
| Extend           | `extend` task, same endpoint                                                                | `video` instance field, same endpoint                                                               |
| Reference images | via `input` parts                                                                           | `referenceImages`, up to 3, not on Lite                                                             |

Three traps for an adapter, all quoted from Google's own docs. Re-reading
an interaction loses the URI: "the `uri` field is only guaranteed to be
present in the initial creation response or Server-Sent Events (SSE)
stream", so it must be captured from the create response.
`interaction.output_video` is SDK-only, so a raw HTTP client must walk
`steps[]` for the `model_output` step. And `personGeneration` takes
different value sets on the Gemini API (`allow_all` / `allow_adult`)
than on Vertex (`allow_adult` / `disallow`), so one enum cannot span
both.

The Interactions API does have SSE with a `VideoDelta` type, which is
the one place progressive video could plausibly hide. It does not: the
streaming guide lists `text`, `image` and `audio` as the delta types for
a `model_output` step and has no video section, Google recommends
`stream=false` for video, and even if a video did arrive in several
deltas that is a transport chunking of one base64 MP4, not something a
player can render early. Marked UNVERIFIED rather than disproven, and
not designed for.

### What the user asked about

There is **no model called "Hailuo 3 Max"**. The official ids are
`MiniMax-H3` (Hailuo 3.0 / Hailuo 03, released 2026-07-31) and
`MiniMax-H3-Max`, which MiniMax's own guide describes as
"co-developed by MiniMax and fal.ai" and "post-trained by fal.ai on
MiniMax H3". fal measured `H3 Max` at 2.82 s for a 5 s 768p clip and
`H3 Max Turbo` at 1.61 s. Neither streams. The streaming one is
`minimax/h3-max/director`, covered below.

**Pruna** is a model optimisation lab that also runs a hosted inference
API at `https://api.pruna.ai/v1/` with header `apikey`, its own model
ids (`p-video`, `p-video-2`, `p-video-2-pro`, `p-video-avatar`) and a
Replicate-shaped submit/poll/download job model. It is genuinely its own
API, not a fal reseller, and it is cheap ($0.025/s for P-Video-2 at 720p
versus $0.08/s for H3 Max). But it is small, carries one vendor's model
family, has no webhooks and no streaming, and the same models are on
Replicate under `prunaai/*`. Not a first-wave provider.

## Streaming: the decisive section

The three things that get called "streaming video" are distinct, and only
one of them is a `VideoGenerator` concern.

### (a) Progressive delivery of one clip: does not exist

No vendor's clip API streams partial frames or segments over SSE,
chunked HTTP or WebSocket. Checked directly:

| Checked                                                                           | Result                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gemini Omni, Veo, MiniMax V2, Grok, Kling, Seedance, Wan, Vidu, Runway, Luma, LTX | all submit-then-poll; MiniMax docs say outright "No streaming of partial video exists"                                                                                                                              |
| fal video endpoints                                                               | thirteen OpenAPI schemas fetched (Veo 3.1, Kling v3 pro and turbo, H3 Max t2v and i2v, Seedance 2.5, Wan 3.0 Prime, LTX-2.5 fast, LTX-2-19b, ltx-video, sync-lipsync, Topaz upscale): **none has a `/stream` path** |
| fal `/stream` generic mechanism                                                   | exists, but fal's docs say "Streaming is only supported by models that have a /stream endpoint" and the only worked example is an image model                                                                       |

Two things look like (a) and are not. The queue
`…/status/stream?logs=1` SSE carries status objects and logs, no media.
`wss://ws.fal.run/{id}` carries the finished response, possibly as binary
chunks, but it is a transport for a completed result, not progressive
rendering.

Architecturally this could change: Sand.ai MAGI is chunk-autoregressive
and ByteDance's Seaweed-APT2 streams at 24 fps in the lab. Neither has a
public API. If it lands it is additive, a new marker and a new method.

### (b) Continuous and interactive generation over WebRTC: real, and elsewhere

| API                                | Transport                                                                                           | What arrives                                                                                                        | Price                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------- |
| fal `minimax/h3-max/director`      | WebRTC via fal's WMA bridge; SDP offer to `POST /session`, 5 s heartbeat, prompts on a data channel | continuous 24 fps 480p/768p video plus 48 kHz stereo audio, generated in 5 to 15 s segments with 12-segment context | $0.08/s, 60 s minimum |
| Decart `lucy-2-5/realtime`         | WebSocket signalling, WebRTC media                                                                  | live video-to-video restyle, 720p 30 fps, sub-40 ms                                                                 | $0.02/s               |
| Runway Characters (`gwm1_avatars`) | WebRTC over LiveKit, `/v1/realtime_sessions`                                                        | conversational avatar, 5 min sessions                                                                               | credits               |
| Odyssey-2 Pro                      | WebRTC plus WebSocket signalling (UNVERIFIED)                                                       | interactive world stream, 720p 22 fps                                                                               | UNVERIFIED            |

The client-side shape here is a bidirectional session: a stream of
inputs (prompts, actions) in, a stream of media events out, scoped to a
connection. That is `MusicGenerator.streamGenerationFrom` and
`RealtimeSession`, not `generate`. Out of scope for this capability.

### (c) Fast async: what "fast streaming model" actually means today

fal's own measurements, 2026-09-09, 9:16 vertical, same prompt:

| Endpoint                                        | Seconds for a 5 s clip |
| ----------------------------------------------- | ---------------------- |
| `minimax/h3-max-turbo/text-to-video`            | 1.61                   |
| `minimax/h3-max/text-to-video`                  | 2.82                   |
| `fal-ai/kling-video/v3/turbo/pro/text-to-video` | 60.72                  |
| `lightricks/ltx-2.5/text-to-video/fast`         | 75.17                  |
| `bytedance/seedance-2.0/mini/text-to-video`     | 117.32                 |

The speed tier has two bands. Band A, under 5 seconds and therefore
faster than playback, is only fal's H3 Max family. Band B, 25 to 120
seconds, is every other "fast" SKU. Both are ordinary queue endpoints
returning a whole file.

This matters for the design: at 1.6 seconds, a blocking `generate` that
hides the poll loop is not a compromise, it is the obvious call. The job
handle exists for Band B and for Veo's documented "max 6 minutes during
peak hours".

## The job model

Almost every provider is submit, poll, download. The exception matters:
**Gemini Omni defaults to synchronous but has an async mode.** The
create call blocks and returns the finished video inline unless you pass
`background: true` (which also requires `store: true`), in which case it
returns an interaction id you poll at `GET /v1beta/interactions/{id}`
and can cancel at `POST /v1beta/interactions/{id}/cancel`. See
[gemini-omni-async.md](./video-generation/gemini-omni-async.md); the
one thing still unconfirmed is a live call proving the server accepts
the flag for this specific model.

Note that `delivery: "uri"` is not the async switch. It only avoids the
roughly 4 MB inline payload limit; the create call still blocks and the
follow-up poll is against the Files API for `ACTIVE`.

So every provider in scope can hand back a durable job id, and the job
surface is uniform.

The differences a design has to absorb:

| Concern                  | Spread                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Status vocabulary        | fal `IN_QUEUE`/`IN_PROGRESS`/`COMPLETED`; MiniMax V2 `queued`/`running`/`succeeded`/`failed`/`cancelled`; MiniMax V1 capitalised `Preparing`/`Queueing`/`Processing`/`Success`/`Fail`; Seedance same as MiniMax V2; Runway adds `THROTTLED` as a task state, not an HTTP error |
| Progress                 | none on Google, MiniMax, Seedance, Kling, Runway. fal has `queue_position` and logs. Sora had an integer percent and is dying.                                                                                                                                                 |
| Cancel                   | fal, MiniMax V2, Seedance, Runway yes. Kling, Luma UNVERIFIED.                                                                                                                                                                                                                 |
| Webhooks                 | fal (ED25519 signed, 31 retries), MiniMax (challenge handshake first), Seedance, Kling (Svix-style HMAC), OpenRouter, Vercel. **Runway has none**, xAI none.                                                                                                                   |
| Result URL lifetime      | Luma ~1 h, Replicate 1 h, MiniMax V1 1 h, Seedance ~24 h (UNVERIFIED), Runway 24 to 48 h, Veo 2 days, Omni Files API 48 h, Kling 30 d, fal configurable via `X-Fal-Object-Lifecycle-Preference`                                                                                |
| Poll cadence in the wild | 5 s (Vercel, xAI), 10 s (Google, MiniMax), 10 to 20 s (OpenAI), 2 s (Replicate)                                                                                                                                                                                                |

Polling-first is mandatory because Runway has no webhooks at all.
Webhooks are an optional accelerator, and receiving them is the
application's job, not the library's.

`packages/core/src/job/Job.ts` already models exactly this:
`JobState<A>` with `Pending`/`Running`/`Succeeded`/`Failed`, a
serialisable `JobRef<A>` branded by result type, `JobOps` with
submit/poll/cancel, and `collect` / `run` driving a jittered poll loop
with a timeout. `DeepResearch.fromJob` is the precedent for deriving a
whole service from three wire ops. Video fits it with one additive
change: `Running` should be able to carry `progress` and
`queuePosition`, both optional, neither promised.

### Prior art on the same problem

| SDK                                    | Method                                                       | Job model                                                        | Result type                           |
| -------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------- |
| Vercel AI SDK                          | `experimental_generateVideo`, `startVideo`, `getVideoStatus` | `doStart` + `doStatus`, JSON-serialisable operation, poll config | bytes; URL results downloaded for you |
| Google GenAI JS                        | `models.generateVideos` + `operations.getVideosOperation`    | LRO handle, manual poll                                          | `uri` or `videoBytes`                 |
| fal client                             | `subscribe`, `queue.submit/status/result`                    | queue handle, poll or status SSE, webhooks                       | `{ video: { url } }`                  |
| Replicate                              | `run({ wait })`                                              | block 60 s then poll                                             | `FileOutput`, 1 h expiry              |
| Runway SDK                             | `create().waitForTaskOutput()`                               | handle + poll, 10 min default                                    | output URLs                           |
| OpenRouter                             | `POST /videos`, `GET /videos/{id}`                           | handle + poll, signed webhooks                                   | URLs needing the API key              |
| LangChain, LlamaIndex, Mastra, Portkey | none                                                         |                                                                  |                                       |

Reported pain points worth designing around: `vercel/ai#21053`, where
the poll deadline did not cover the in-flight status request, and
`#21000`, where `pollTimeoutMillis` was implemented as an attempt count.
`Job.collect` already uses `Effect.timeoutOrElse` around the whole
repeat, so both bugs are structurally impossible here.

## Common request analysis

Field-by-field, with the verdict. "Native" means the vendor takes it as
a first-class parameter with matching semantics.

| Field                 | Native on                                                                                | Verdict                                            |
| --------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `prompt`              | all                                                                                      | **common**, plain string                           |
| `model`               | all                                                                                      | **common**, provider narrows                       |
| `image` (first frame) | all                                                                                      | **common**, `ImageSource`                          |
| `lastFrame`           | Veo, Kling, Seedance, MiniMax, Luma, Runway                                              | **common**, optional                               |
| `duration`            | all                                                                                      | **common** as a number of seconds; adapters encode |
| `aspectRatio`         | Veo, Kling, Seedance, MiniMax, Luma, xAI                                                 | **common**, reuse `AspectRatio` from `Media.ts`    |
| `resolution`          | Veo, Seedance, MiniMax, Luma, xAI, Kling                                                 | **common** as a tier                               |
| `seed`                | Veo, Runway, Seedance, xAI, some fal                                                     | **common**, optional, bucket 3                     |
| `negativePrompt`      | Veo, Kling v1.x only (3.x dropped it)                                                    | provider-typed                                     |
| `referenceImages`     | all, with incompatible semantics                                                         | provider-typed                                     |
| `video` (extend, v2v) | Veo, Kling, Seedance, Runway, Luma                                                       | provider-typed                                     |
| `n`                   | Veo only (`numberOfVideos`)                                                              | drop, callers loop                                 |
| `fps`                 | Veo config, LTX                                                                          | drop, report it on the result                      |
| `cameraControl`       | Kling had a DSL and dropped it; Seedance has `camera_fixed`; MiniMax has prompt brackets | provider-typed                                     |
| `enhancePrompt`       | Veo off by default, MiniMax on by default, fal `auto_fix`                                | provider-typed, defaults disagree                  |
| `watermark`           | Seedance, Kling                                                                          | provider-typed                                     |
| `audio`               | contested, see below                                                                     | see below                                          |

`duration` deserves a note because it is the least uniform field that
still belongs in the common request. The encodings are `"8s"` (fal Veo),
`"5"` (fal Kling), `8` (MiniMax, Seedance, Runway, xAI), `"auto"`
(Seedance, LTX), `"5s"` as a closed enum (Luma), and `num_frames` plus
`fps` (LTX-2-19b). A number of seconds is the one thing they all
project from, so the common request carries a number and each adapter
owns its encoding, failing with the allowed set when the value is not
representable.

Two ratio traps: Runway uses pixel pairs (`"1280:720"`) for its own
models but plain ratios for hosted ones, and several vendors have an
`"adaptive"` value meaning "follow the input image". Neither belongs in
the portable type; `AspectRatio` already carries a `(string & {})` tail
for the first and `undefined` covers the second.

### Audio: the one genuinely contested field

The reports disagree, so here is the raw split.

| Vendor                                     | Audio                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| Seedance 2.x, 1.5 Pro                      | `generate_audio` boolean, default true                                            |
| xAI Grok Imagine                           | `generate_audio`, default true                                                    |
| Wan                                        | `audio` boolean                                                                   |
| Kling 3.x                                  | `settings.audio`: `native` / `original` / `off`, tri-state, default `off`         |
| Veo 3.1 / Fast / Lite                      | always on, **no toggle**: "Audio: Natively generates audio with video. Always on" |
| Gemini Omni                                | always on, **no toggle**                                                          |
| MiniMax H3                                 | always on, **no toggle**                                                          |
| Runway own models (`gen4.5`, `gen4_turbo`) | **silent**; audio is a separate endpoint family                                   |
| Luma Ray3.2                                | **no audio at all**                                                               |

So: three plain booleans, one tri-state, three always-on, two that
cannot do it. That is not "genuinely shared". Under the repo's own rule,
a field earns the common request only when the toggle is genuinely
shared across providers, and this one is not.

Two subagent reports initially disagreed here, both citing a Veo
`generateAudio` parameter. That parameter is real but stale: it was a
Veo 2 and early Veo 3 Vertex field and does not appear on any current
Veo 3.1 page. What does expose `generate_audio` is **fal's wrapper**
around Veo, Kling, Seedance and LTX, which is fal normalising over
models whose native APIs mostly lack the knob. That makes it a
fal-typed field, not evidence of an industry norm.

The recommendation is to split the direction:

- **Request side: provider-typed.** A common `audio?: boolean` would
  promise default behaviour that Luma and Runway cannot deliver and that
  MiniMax cannot turn off. The aggregators that do expose a common
  boolean (Vercel, OpenRouter) are normalising over a subset that
  excludes exactly those vendors.
- **Result side: common.** Every vendor returns one MP4 with audio muxed
  in or not; nobody returns a separate track. `hasAudio` on the result is
  uniform, observable, and is the thing a caller actually branches on
  when deciding whether to mux a TTS or music track.

This is the honest version and it stays consistent with how the speech
capability treats non-uniform knobs. It is flagged as a decision for
review in the plan, since it is the one place the subagent reports
reached opposite conclusions.

**Input audio is a different request shape entirely.** Three exist:
image plus audio (Hedra, fal InfiniTalk, OmniHuman, Wan S2V), video plus
audio (sync-lipsync, Kling lip-sync), and audio as a generation
reference (Seedance `role: "reference_audio"`, up to 3 clips). Only the
third is an extension of an ordinary request, and only one vendor has
it. Audio-driven video is a separate capability taking an `AudioBlob`,
which is precisely what makes a speech or music result composable with
it. Not in this scope.

## Recipes

Ranked by how much existing capability they compose and how well they
survive a provider churn.

| Recipe                | What it does                                                                                                                                                     | Composes                                                | Why                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product-clip`        | Hero still (generated or supplied) animated by an image-to-video model, audio on, download and persist                                                           | image generator, video generator                        | The dominant production pattern (AdVon's 93,673-product catalogue on Veo, Agoda, Google Ads). Exercises the whole job model with the fewest moving parts. |
| `storyboard-to-video` | LLM writes a shot list as structured output, image generator renders a keyframe per shot, video generator animates each with `lastFrame` chaining for continuity | LLM structured output, image generator, video generator | Shows fan-out over N jobs, per-shot retry, and why `lastFrame` is common. Mirrors the existing `storyboard` image recipe.                                 |
| `ad-variants`         | One brief, K hooks from an LLM, N vertical clips with a cost and seed manifest                                                                                   | LLM, video generator, optional image generator          | Matches the broadcaster case of 800 to 1000 ads a year through the API. Best showcase for the fast tier.                                                  |
| `clip-extend`         | Chain provider-typed extensions to reach 30 to 60 s from one seed clip                                                                                           | video generator only                                    | Small, and the natural docs home for the provider-typed `video` input.                                                                                    |

Deferred: `talking-head` needs the audio-driven capability that is out
of scope here, though it is the highest-traffic commercial use and the
best proof that an `AudioBlob` from one capability feeds another.
`music-video` needs a compositor for the mux step, which lives outside
the library.

Rejected: game assets (no vendor produces alpha or tileable loops),
video-to-video style transfer as a portable recipe (Runway Aleph, Luma
Modify and xAI editing share no knobs), real-person avatars (Sora and
Seedance reject real faces, Veo gates it, and the policy surface exceeds
the code), beat-synced editing (needs onset detection and a timeline),
and multi-shot character consistency (depends on vendor reference
systems that have not converged).

## Repo audit: what core already has

Checked 2026-09-19 against `packages/core/src`.

- [Media.ts](../../packages/core/src/domain/Media.ts) already anticipated
  this. `AspectRatio` carries the comment "Shared by image and video
  generation", and the resolution comment says "video models tier by
  scan height. Each modality types its own." So `AspectRatio` is reused
  as is and `VideoResolution` is new and video-typed, exactly as
  planned. `Watermark` and `MediaSource` are reusable unchanged.
- [Job.ts](../../packages/core/src/job/Job.ts) has the whole poll driver.
  Needs one additive change: optional `progress` and `queuePosition` on
  `Running`.
- There is no `domain/Video.ts`. Needs `VideoMimeType`, `VideoSource`
  as `MediaSource<VideoMimeType>`, and `GeneratedVideo`.
- [DeepResearch.ts](../../packages/core/src/research/DeepResearch.ts) is
  the `fromJob` precedent: submit, status, collect, cancel and a
  blocking convenience, all derived from three wire ops.
- `@effect-uai/fal` exists with an image adapter whose endpoint-as-model,
  per-endpoint schema and `providerData` handling all transfer. It is
  currently sync-only against `fal.run`; video needs the queue client.
- `docs/video-generation/index.md` exists as a "coming soon" stub naming
  Veo, Sora, Runway and Luma. Its framing (async job archetype,
  submit/track/fetch, cancellable polling) is correct and survives; its
  provider list needs replacing.

## Sources

Raw reports: [landscape.md](./video-generation/landscape.md),
[aggregators.md](./video-generation/aggregators.md),
[minimax-bytedance.md](./video-generation/minimax-bytedance.md),
[runway-kling-luma.md](./video-generation/runway-kling-luma.md),
[google-veo.md](./video-generation/google-veo.md),
[gemini-omni-async.md](./video-generation/gemini-omni-async.md)
(supplements and corrects the Omni half of `google-veo.md`),
[openai-sora.md](./video-generation/openai-sora.md) (retained as a
reference for the job-object design, not as a provider),
[prior-art-and-use-cases.md](./video-generation/prior-art-and-use-cases.md).
