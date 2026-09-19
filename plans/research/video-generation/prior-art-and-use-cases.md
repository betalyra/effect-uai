# Subagent report: video generation, SDK prior art and use cases (2026-09-19)

Raw research report. The summary and decisions live in `../video-generation.md`.

Conventions: "UNVERIFIED" marks claims taken from search snippets or third-party mirrors that could not be confirmed against official docs or source. Everything else is quoted from vendor docs, SDK source, or GitHub issues as of 2026-09-19.

Headline findings before the detail:

1. Every SDK that ships video generation models it as an async job. The two mature designs are Vercel AI SDK's `doStart` / `doStatus` split with a JSON-serialisable `operation` handle, and the fal queue (`submit` / `status` / `result` plus `subscribe` sugar). Blocking one-call helpers exist everywhere but are sugar over the same handle.
2. The OpenAI Videos API (Sora 2) shuts down on 2026-09-24, five days from now. It is still the best-documented "job object" design (status, progress, expires_at, download variants) but must not be a launch provider.
3. Result delivery is split: URL providers (fal, Kling, MiniMax, Runway, Luma, xAI, OpenRouter, Replicate) versus bytes/file providers (Veo via `files.download`, Sora via `/content`). URLs expire fast (Replicate 1 h, Sora 1 h, MiniMax 9 h, Veo 2 days server-side, fal "configurable", OpenRouter "until job expiry"). Every SDK that hides the difference downloads the URL for you.
4. A `generateAudio: boolean` toggle is now genuinely common (Veo, Kling 2.6+, Seedance, Runway `audio`, xAI, Luma, fal Veo endpoints, OpenRouter, Vercel). Input audio (audio-driven video, lip sync) is a different capability with a different request shape (image + audio, or video + audio) and is not part of text/image-to-video.

---

## Part 1: SDK prior art

### 1.1 Vercel AI SDK (`ai`, `experimental_generateVideo`)

Status: shipped in AI SDK 6+, still `experimental_` prefixed. Spec version is `VideoModelV4` (V3 was a single `doGenerate` and is superseded).

Public surface (from https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-video and https://raw.githubusercontent.com/vercel/ai/main/packages/ai/src/generate-video/generate-video.ts):

```ts
export async function experimental_generateVideo({
  model: VideoModel;
  prompt: string | { image?: DataContent; text?: string };
  n?: number;
  maxVideosPerCall?: number;
  aspectRatio?: `${number}:${number}` | 'adaptive';
  resolution?: `${number}x${number}`;
  duration?: number;               // seconds
  fps?: number;
  seed?: number;
  frameImages?: Array<{ image: DataContent; frameType: 'first_frame' | 'last_frame' }>;
  inputReferences?: Array<DataContent | { data: DataContent; mediaType?: string }>;
  generateAudio?: boolean;
  providerOptions?: ProviderOptions;
  maxRetries?: number;
  abortSignal?: AbortSignal;
  headers?: Record<string, string>;
  download?: (options) => Promise<{ data: Uint8Array; mediaType: string }>;
  poll?: { intervalMs?: number /* 5000 */; timeoutMs?: number /* 600000 */; delay?: (ms, { abortSignal }) => PromiseLike<void> };
  webhook?: () => PromiseLike<{ url: string; received: PromiseLike<{ headers; body }> }>;
}): Promise<{
  video: GeneratedFile;            // { base64, uint8Array, mediaType }
  videos: Array<GeneratedFile>;
  warnings: Warning[];
  responses: Array<{ timestamp; modelId; headers }>;
  providerMetadata?: Record<string, JSONValue>;
}>
```

Provider spec (from https://raw.githubusercontent.com/vercel/ai/main/packages/provider/src/video-model/v4/):

```ts
// video-model-v4.ts
doGenerate?(options: VideoModelV4CallOptions): PromiseLike<VideoModelV4Result>;
doStart?(options: VideoModelV4CallOptions & { webhookUrl?: string }): PromiseLike<VideoModelV4OperationStartResult>;
doStatus?(options: { operation: JSONValue; abortSignal?; headers? }): PromiseLike<VideoModelV4OperationStatusResult>;
handleWebhookOption?(...)

// video-model-v4-operation-start-result.ts
type VideoModelV4OperationStartResult = { operation: JSONValue; warnings; providerMetadata?; response: { timestamp; modelId; headers } };

// video-model-v4-operation-status-result.ts
type VideoModelV4OperationStatusResult =
  | { status: 'pending'; warnings?; providerMetadata?; response }
  | { status: 'completed'; videos: Array<VideoModelV4VideoData>; warnings; providerMetadata?; response }
  | { status: 'error'; error: string; providerMetadata?; response };

// video-model-v4-result.ts
type VideoModelV4VideoData =
  | { type: 'url'; url: string; mediaType: string }
  | { type: 'base64'; data: string; mediaType: string }
  | { type: 'binary'; data: Uint8Array; mediaType: string };
```

Call options (`video-model-v4-call-options.ts`): `prompt`, `n`, `aspectRatio`, `resolution`, `duration`, `fps`, `seed`, `image`, `frameImages`, `inputReferences`, `generateAudio`, `providerOptions`, `abortSignal`, `headers`. Doc comment on `n`: "Most video models only support n=1 due to computational cost." Doc comment on the result: "Most providers return URLs to video files (MP4, WebM)."

Job model: three flows.

| Flow | Entry point | Notes |
|---|---|---|
| Blocking single call | `experimental_generateVideo` without `poll` | Provider adapter polls upstream inside one request; `providerOptions.<provider>.pollIntervalMs` / `pollTimeoutMs` control that inner loop (klingai default 5000 / 600000). Hits Node undici 5 min `headersTimeout` unless you build a custom `Agent` (https://vercel.com/docs/ai-gateway/modalities/video-generation#extending-timeouts-for-nodejs). |
| Start + poll in the SDK | `experimental_generateVideo` with `poll: {...}` | SDK calls `doStart`, then `doStatus` every `intervalMs`, throws a polling timeout at `timeoutMs`. `poll.delay` lets a durable workflow supply its own sleep. |
| Split | `experimental_startVideo` / `experimental_getVideoStatus` (ai@7.0.76+) | `startVideo` returns `{ operation, providerMetadata }`; `operation` is "a JSON-serializable value: persist it in a queue or database and check the job from any process". `getVideoStatus` returns `pending | completed (videos) | error` and "does not download hosted results". "There is no built-in timeout." |

Webhooks: `startVideo({ webhookUrl })` or a `webhook` factory on `generateVideo`; AI Gateway posts `video.generation.completed | failed | cancelled` with "terminal facts only, never video URLs or bytes", signed via `x-ai-gateway-signature: t=<unix>,v1=<hmac>`; retries carry `x-ai-gateway-idempotency-key: <jobId>-<status>`. Start requests carry an automatic `idempotency-key` header "so its internal retries never bill a second generation".

Progress: none. Only `pending` / `completed` / `error`; no percentage, no logs.

Result: bytes. "when a provider returns a URL, the SDK downloads it for you, so `videos[0].uint8Array` works either way." Default download limit 2 GiB, overridable via `download`. `providerMetadata.gateway.asyncJob.result.expiresAt` tells you how long a hosted asset stays reachable.

Common fields vs provider options: `prompt` (string or `{ image, text }`), `duration` (number seconds), `aspectRatio` (`W:H` or `adaptive`), `resolution` (`WxH`), `fps`, `seed`, `n`, `frameImages`, `inputReferences`, `generateAudio`. Everything else is `providerOptions`: klingai `mode | cfgScale | negativePrompt | cameraControl | sound ('on'|'off') | imageTail | multiShot | elementList | videoUrl | watermarkEnabled`; bytedance `watermark | generateAudio | cameraFixed | returnLastFrame | draft | referenceImages | referenceVideos | referenceAudio | lastFrameImage` (https://ai-sdk.dev/providers/ai-sdk-providers/klingai, https://ai-sdk.dev/providers/ai-sdk-providers/bytedance). Vercel notes precedence rules: `first_frame` in `frameImages` beats `prompt.image`; `frameImages` beats `inputReferences` (warning emitted).

Providers listed on https://ai-sdk.dev/docs/ai-sdk-core/video-generation: Google Vertex (veo-3.1, veo-3.0, veo-2.0), Black Forest Labs `flux-3-video`, fal (`luma-dream-machine/ray-2`, `minimax-video`), xAI (`grok-imagine-video`, `-1.5`), Kling (`kling-v2.6-t2v` etc.), Replicate (`minimax/video-01`); via AI Gateway also ByteDance Seedance, Alibaba Wan, MiniMax H3.

Pain points from issues:

- https://github.com/vercel/ai/issues/21053 "generateVideo polling timeout does not cancel in-flight status requests": `poll.timeoutMs` was checked between polls but not applied to an in-flight `doStatus`; a late completion after the deadline was accepted. Fixed in PR #21066 by racing `doStatus` against a deadline abort signal. Lesson: the deadline must cover the status request, not just the sleep.
- https://github.com/vercel/ai/issues/21000 "`pollTimeoutMillis` is implemented as a maximum attempt count in image providers": BFL and Fireworks counted attempts, so "Time spent inside each polling request is not included in the timeout." Proposal: either a real wall-clock deadline or rename to `maxPollAttempts` (Luma already exposes `maxPollAttempts`). Lesson: pick one semantics and name it honestly.
- Undici 5 min default `headersTimeout`/`bodyTimeout` kills the blocking flow for Veo/Kling jobs; the docs' workaround is a custom `Agent` with 15 min timeouts.
- AI Gateway persists the start request capped at 300 KiB, so inline base64 images fail with 413 in async mode; "Pass images and videos as hosted URLs rather than inline base64".
- The webhook factory flow has to capture the signing secret by wrapping `fetch` ("treat it as a stopgap").

### 1.2 Google GenAI JS SDK (`@google/genai`)

Surface (https://ai.google.dev/gemini-api/docs/veo, https://googleapis.github.io/js-genai/release_docs/classes/models.Models.html#generatevideos, https://googleapis.github.io/js-genai/release_docs/interfaces/types.GenerateVideosConfig.html):

```ts
let operation = await ai.models.generateVideos({
  model: 'veo-3.1-generate-preview',
  prompt: '...',
  image?: Image,          // first frame (imageBytes | gcsUri, mimeType)
  video?: Video,          // previous Veo output, for extension
  config?: GenerateVideosConfig,
});
while (!operation.done) {
  await new Promise((r) => setTimeout(r, 10000));
  operation = await ai.operations.getVideosOperation({ operation });
}
await ai.files.download({ file: operation.response.generatedVideos[0].video, downloadPath: 'out.mp4' });
```

`GenerateVideosConfig` fields: `aspectRatio` ("16:9" | "9:16"), `resolution` ("720p" | "1080p" | "4k"), `durationSeconds` (number in the SDK type; the Gemini doc page lists "4" | "6" | "8"), `fps`, `negativePrompt`, `seed`, `numberOfVideos`, `personGeneration` ("dont_allow" | "allow_adult" | "allow_all"), `enhancePrompt`, `generateAudio`, `lastFrame: Image`, `referenceImages: VideoGenerationReferenceImage[]` ("Up to 3 asset images or 1 style image"), `compressionQuality`, `resizeMode`, `mask`, `outputGcsUri` (Vertex), `pubsubTopic`, `webhookConfig`, `labels`, `httpOptions`, `abortSignal`.

Job model: Google long-running operation. `generateVideos` returns `GenerateVideosOperation` with `done`, `response.generatedVideos[].video: { uri?, videoBytes?, mimeType? }`. Polling is manual; the docs use 10 s. No progress percentage.

Result: a `Video` with `uri` (Gemini API file, download via `ai.files.download`) or `videoBytes` (base64), or `gcsUri` on Vertex via `outputGcsUri`. "Generated videos are stored on the server for 2 days". Output is 24 fps, MP4.

Model limits (Gemini API page): Veo 3.1 / 3.1 Fast / 3.1 Lite, durations 4/6/8 s, 16:9 or 9:16, 720p/1080p, 4K on 3.1 only at 8 s, extension only at 720p, reference images require 8 s. Audio is native ("Veo 3.1 is a model for generating video with native audio"), `generateAudio` toggles it. Extension takes a previous Veo `video` and continues it; audio "can't be effectively extended if absent in final second".

Constraint worth copying: Veo's image-to-video with a person is gated by `personGeneration`; Sora and Seedance reject real faces in input images outright.

### 1.3 OpenAI Node SDK (`openai`), Videos API / Sora 2

Deprecation: the SDK source carries `@deprecated "The Sora API is scheduled to permanently shut down on September 24, 2026."` (https://raw.githubusercontent.com/openai/openai-node/master/src/resources/videos.ts). OpenAI's deprecations page: the Videos API and `sora-2`, `sora-2-pro` and all snapshots are removed on 2026-09-24 with no replacement listed (https://developers.openai.com/api/docs/deprecations). Do not ship this provider; keep the design as reference only.

Surface (https://developers.openai.com/api/docs/guides/video-generation):

```ts
const video = await openai.videos.create({ model: 'sora-2', prompt: '...', size: '1280x720', seconds: '8', input_reference: file });
// Video: { id, object: 'video', status: 'queued'|'in_progress'|'completed'|'failed', progress: 0..100, model, seconds, size, created_at, expires_at?, error?, remixed_from_video_id? }
while (video.status === 'queued' || video.status === 'in_progress') { await sleep(2000); video = await openai.videos.retrieve(video.id); }
const content = await openai.videos.downloadContent(video.id, { variant: 'video' | 'thumbnail' | 'spritesheet' }); // Response (stream)
```

Also `videos.list`, `videos.delete`, `videos.remix` (the guide says edits deprecate remix), `POST /v1/videos/extensions` (up to 20 s per segment, max 6 extensions), `POST /v1/videos/characters`. Types in the Node SDK: `VideoSeconds = '4' | '8' | '12'` (string!), `VideoSize = '720x1280' | '1280x720' | '1024x1792' | '1792x1024'`. The guide also lists `1920x1080`, `1080x1920`, `768x432`, `432x768` and `seconds` up to 20 for the newer models.

`createAndPoll`: the Python SDK has `client.videos.create_and_poll` (guide shows it). The Node `videos.ts` resource does not contain a polling loop; the openai-node `helpers.md` describes `...AndPoll` helpers generically. UNVERIFIED whether `client.videos.createAndPoll` exists in Node at HEAD.

Job model: handle + poll, plus project-level webhooks `video.completed` / `video.failed` (payload has ids only). Progress: integer `progress` 0..100. Guidance: "Poll every 10 to 20 seconds (use exponential backoff if needed)".

Result: bytes via `/content` (MP4 default, plus WebP thumbnail and JPG spritesheet variants). "Download URLs: Valid 1 hour maximum after generation" and batch outputs 24 h. Videos have `expires_at` and a terminal `expired` status.

Common fields: `prompt`, `model`, `size` (pixels string, must match `input_reference` resolution), `seconds` (string enum), `input_reference` (single image = first frame, multipart). No aspectRatio, no seed, no audio toggle (audio is always generated), no negative prompt.

### 1.4 fal JS client (`@fal-ai/client`)

Surface (https://raw.githubusercontent.com/fal-ai/fal-js/main/libs/client/README.md, https://fal.ai/docs/model-endpoints/queue):

```ts
fal.config({ credentials: 'FAL_KEY' });
const { data, requestId } = await fal.subscribe('fal-ai/veo3.1', {
  input: { prompt, aspect_ratio: '16:9', duration: '8s', resolution: '720p', generate_audio: true },
  logs: true,
  onQueueUpdate: (update) => {
    if (update.status === 'IN_PROGRESS') update.logs.map((l) => l.message).forEach(console.log);
  },
});
// lower level
const { request_id } = await fal.queue.submit(id, { input, webhookUrl });
const status = await fal.queue.status(id, { requestId, logs: true }); // IN_QUEUE {queue_position} | IN_PROGRESS {logs} | COMPLETED {logs, metrics.inference_time}
const result = await fal.queue.result(id, { requestId });
await fal.queue.cancel(id, { requestId });
```

`fal.subscribe` options `pollInterval`, `mode: 'polling' | 'streaming'` (SSE status stream at `.../status/stream?logs=1`), `webhookUrl`, `onEnqueue` are in the client typings; UNVERIFIED from the README excerpt but consistent with the queue docs (`fal_webhook` query param, `status_url`, `response_url`, `cancel_url` returned on submit). `fal.run` is the synchronous path (unsuitable for video). `fal.storage.upload(file)` uploads inputs and returns a URL.

Job model: queue handle + poll or SSE stream; webhooks; "No queue size limits"; server retries 503/504 up to 10 times unless `X-Fal-No-Retry: 1`.

Progress: `queue_position` while queued, `logs[]` while running (free text), `metrics.inference_time` on completion. No percentage.

Result: JSON output with `video: { url, content_type, file_name, file_size }` on every video endpoint. URLs live on the fal CDN; retention is "Configurable" per request via `X-Fal-Object-Lifecycle-Preference: {"expiration_duration_seconds": n | null}`; request JSON is kept 30 days (https://fal.ai/docs/documentation/model-apis/media-expiration). A search snippet says "at least 7 days by default", UNVERIFIED.

Common fields: none at the client level; every endpoint has its own schema. Sample schemas:

| Endpoint | Fields |
|---|---|
| `fal-ai/veo3.1` (https://fal.ai/models/fal-ai/veo3.1/api) | `prompt`, `aspect_ratio` "16:9" \| "9:16", `duration` "4s" \| "6s" \| "8s", `resolution` "720p" \| "1080p" \| "4k", `generate_audio` (default true), `negative_prompt`, `seed`, `auto_fix`, `safety_tolerance` |
| `fal-ai/kling-video/v2.5-turbo/pro/image-to-video` (https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video/api) | `prompt`, `image_url`, `duration` "5" \| "10", `negative_prompt`, `cfg_scale` 0..1, `aspect_ratio` "16:9" \| "9:16" \| "1:1", `tail_image_url` |
| `fal-ai/kling-video/lipsync/audio-to-video` | `video_url`, `audio_url` (2 to 60 s, 5 MB) |
| `fal-ai/wan/v2.2-14b/speech-to-video` | `prompt`, `image_url`, `audio_url`, `resolution`, `num_frames`, `frames_per_second`, `seed` |
| `fal-ai/sync-lipsync/v2` | `video_url`, `audio_url`, `model`, `sync_mode` "cut_off" \| "loop" \| "bounce" \| "silence" \| "remap" |

Note the format drift even inside fal: Veo duration is `"8s"`, Kling duration is `"5"`, Wan is `num_frames`.

### 1.5 Replicate JS client (`replicate`)

Surface (https://github.com/replicate/replicate-javascript/blob/main/README.md, https://replicate.com/docs/topics/predictions/create-a-prediction):

```ts
const output = await replicate.run('minimax/video-01', {
  input: { prompt },
  wait: { mode: 'block' | 'poll', interval: 500, timeout: 60 },
  webhook, webhook_events_filter: ['start','output','logs','completed'],
  signal,
}, (prediction) => { /* progress callback with the full prediction */ });
// or handle + poll
const p = await replicate.predictions.create({ model, input, webhook });
await replicate.wait(p); await replicate.predictions.get(p.id); await replicate.predictions.cancel(p.id);
```

Job model: `Prefer: wait` blocks up to 60 s (default), then returns the incomplete prediction with `status: starting | processing`; the client then polls `urls.get`. Terminal states `succeeded | failed | canceled`. Webhooks with event filters.

Progress: `logs` string on the prediction (the progress callback receives it); no percentage.

Result: `FileOutput` objects, which are `ReadableStream`s with `.url()` and `.blob()`; `useFileOutput: false` returns plain URLs. "URLs for files point to replicate.delivery and expire after one hour" and prediction data is removed after an hour by default (https://replicate.com/docs/topics/predictions/output-files, https://replicate.com/docs/topics/predictions/data-retention).

Common fields: none; `input` is the model's own schema.

### 1.6 LangChain / LlamaIndex

- LangChain: no video generation abstraction. Issue https://github.com/langchain-ai/langchain/issues/34387 proposed `ImageGenerationModel` and `VideoGenerationModel` base classes (`generate(prompt, frames, fps, conditioning_images, **kwargs)`) and was "Closed as not planned". https://github.com/langchain-ai/langchain-google/issues/1046 requests Veo 3 support; no shipped integration found. Langflow (separate product) has a "Google Video Generator" component calling Veo (https://www.langflow.org/templates/use-langflow-to-generate-ai-videos-from-text-with-google-veo/).
- LlamaIndex: no video generation integration found (searches return only third-party aggregators). UNVERIFIED negative.

### 1.7 Mastra

No video generation capability in the docs (https://mastra.ai/docs); searches for Mastra + Veo/Sora return nothing. Mastra delegates model calls to the Vercel AI SDK, so a user could call `experimental_generateVideo` inside a Mastra tool, but there is no Mastra surface.

### 1.8 LiteLLM

Has a unified `/videos` API modelled on the OpenAI Videos endpoint (https://docs.litellm.ai/docs/videos):

```python
response = video_generation(model="openai/sora-2", prompt="...", seconds="8", size="720x1280", input_reference=file)
status = video_status(video_id=response.id)          # {id, object:'video', status: queued|processing|completed, progress, model, size, seconds}
bytes_ = video_content(video_id=response.id)
```

Plus `video_remix`, `video_list`, `video_delete`, async variants; proxy routes `POST /v1/videos`, `GET /v1/videos/{id}`, `GET /v1/videos/{id}/content`. Providers: `openai`, `azure`, `gemini`, `vertex_ai`, `runwayml` (https://docs.litellm.ai/docs/providers/runwayml/videos, https://docs.litellm.ai/docs/providers/gemini/videos). Common fields are the OpenAI ones only: `prompt`, `model`, `seconds` (string), `size` (`WxH`), `input_reference`. Everything else passes through. The design inherits OpenAI's string `seconds` and pixel `size`, which map badly onto Veo ("720p", "16:9") and Runway ("1280:720"). With Sora gone, this schema's anchor disappears.

### 1.9 Portkey

No video generation. Multimodal capabilities listed are vision, image generation, function calling, STT, TTS (https://portkey.ai/docs/product/ai-gateway/multimodal-capabilities).

### 1.10 OpenRouter

Launched 2026-04-16 (https://openrouter.ai/blog/announcements/video-generation/). Surface (https://openrouter.ai/docs/guides/overview/multimodal/video-generation):

```
POST /api/v1/videos            { model, prompt, duration (int), resolution ('480p'..'4K'), aspect_ratio ('16:9'), size ('WxH'), frame_images: [{ image, frame_type: 'first_frame'|'last_frame' }], input_references: [...], generate_audio, seed, callback_url, provider: {...} }
  -> 202 { id, polling_url, status: 'pending' }
GET  /api/v1/videos/{jobId}    -> { id, status: pending|in_progress|completed|failed, generation_id, unsigned_urls: [...], usage: { cost, is_byok }, error? }
GET  /api/v1/videos/{jobId}/content?index=0
GET  /api/v1/videos/models
```

Job model: handle + poll; webhooks `video.generation.completed | failed | cancelled | expired` with `X-OpenRouter-Idempotency-Key: <job_id>-<status>` and optional HMAC `X-OpenRouter-Signature`. Progress: status only. Result: `unsigned_urls` that require the API key in `Authorization` ("These URLs are not presigned"), valid until job expiry. Common fields: the same set as Vercel plus `size` and `callback_url`, provider-specific under `provider`. Models: `google/veo-3.1`, `alibaba/wan-2.7`, `minimax/hailuo-3`, Seedance, Sora 2 Pro (at launch). The OpenRouter schema and the Vercel V4 schema converged on the same names (`frame_images` / `frameImages`, `input_references` / `inputReferences`, `generate_audio` / `generateAudio`), which is strong evidence for that vocabulary.

### 1.11 Others worth a line

- TanStack AI: `generateVideo()` returns `{ jobId, model }`, then status/content calls; adapters for OpenAI Sora, OpenRouter (`/api/v1/videos`), Grok Imagine. Media inputs use a `MediaInputRole` taxonomy (`start_frame`, `end_frame`, `reference`, `character`) mapped to `frame_images` / `input_references` (https://github.com/TanStack/ai/issues/707, https://github.com/TanStack/ai/issues/705). Their OpenRouter adapter "throws on non-empty" `videoInputs` and `audioInputs`.
- Runway Node SDK (`@runwayml/sdk`): `client.imageToVideo.create({...}).waitForTaskOutput({ timeout?, abortSignal? })`; default timeout ten minutes, throws `TaskTimedOutError` or `TaskFailedError` (https://docs.dev.runwayml.com/api-details/sdks/). Create returns `{ id, estimatedCost: { credits } }`. `ImageToVideoCreateParams` is a discriminated union per model (Gen4_5, Gen4Turbo, Veo3_1, Seedance2, Hailuo3, Wan3, GrokImagine1_5, GeminiOmniFlash, ...), each with its own `ratio` union (`'1280:720' | '720:1280' | '1104:832' | ...`), `duration` union (Veo `4 | 6 | 8`, Gen4.5 `2..10`, Seedance `number | 'auto'`), and `audio: boolean` where supported; `promptImage` is a string or `[{ uri, position: 'first' | 'last' }]` (https://raw.githubusercontent.com/runwayml/sdk-node/main/src/resources/image-to-video.ts). Runway is itself an aggregator now, and its per-model union types are an honest picture of how non-uniform the knobs are.
- Amazon Nova Reel (Bedrock): `StartAsyncInvoke` with `videoGenerationConfig: { durationSeconds, fps: 24, dimension: '1280x720', seed }` and an S3 `outputDataConfig`; ~90 s for 6 s of video (https://docs.aws.amazon.com/nova/latest/userguide/video-gen-access.html). Output to your own bucket is the one design that sidesteps URL expiry entirely.
- Google Gemini "Omni Flash" also generates video via `generateContent` (Gemini API video page); out of scope here.

### 1.12 Prior-art comparison

| SDK | Method | Job model | Progress | Result type | Common fields |
|---|---|---|---|---|---|
| Vercel AI SDK | `experimental_generateVideo`, `experimental_startVideo`, `experimental_getVideoStatus` | `doStart` + `doStatus` with JSON `operation`; optional blocking `doGenerate`; webhooks | `pending`/`completed`/`error` only | bytes (`uint8Array`, `base64`, `mediaType`), URL downloaded for you | prompt, image, frameImages, inputReferences, duration, aspectRatio, resolution, fps, seed, n, generateAudio |
| Google GenAI JS | `models.generateVideos` + `operations.getVideosOperation` | LRO handle, manual poll | `done` boolean | `Video { uri | videoBytes, mimeType }`, `files.download` | Veo config object (not cross-provider) |
| OpenAI Node | `videos.create / retrieve / downloadContent` | handle + poll, webhooks | `progress` 0..100 | streamed bytes, variants | prompt, size, seconds, input_reference |
| fal client | `subscribe`, `queue.submit/status/result` | queue handle, poll or SSE, webhooks | queue_position + logs | `{ video: { url } }` | none (per-endpoint schema) |
| Replicate | `run({ wait })`, `predictions.*` | block-then-poll, webhooks | logs | `FileOutput` (stream, `.url()`) | none |
| LiteLLM | `video_generation / video_status / video_content` | handle + poll | `progress` | bytes | OpenAI fields |
| OpenRouter | `POST /videos`, `GET /videos/{id}` | handle + poll, webhooks | status | `unsigned_urls` | Vercel-like snake_case set |
| Runway SDK | `imageToVideo.create().waitForTaskOutput()` | handle + poll (SDK loop) | status | `output: [url]` | per-model unions |
| LangChain / LlamaIndex / Mastra / Portkey | none | | | | |

---

## Part 2: common request analysis

Vendor value formats (native APIs, not aggregators):

| Field | Veo (Gemini API) | Sora 2 (dead 09-24) | Runway | Kling | MiniMax | Seedance (ModelArk) | Luma | xAI Grok Imagine |
|---|---|---|---|---|---|---|---|---|
| prompt | `prompt` | `prompt` | `promptText` | `prompt` (max 2500) | `prompt` (max 2000) | `content[{type:'text'}]` | `prompt` | `prompt` |
| first frame | `image` | `input_reference` (multipart) | `promptImage` or `[{uri, position:'first'}]` | `image` | `first_frame_image` | `content[{type:'image_url', role:'first_frame'}]` | `keyframes.frame0` | `image: {url}` |
| last frame | `config.lastFrame` | no | `position:'last'` (Veo, Seedance only) | `image_tail` (pro) | `last_frame_image` (UNVERIFIED on current doc) | `role:'last_frame'` | `keyframes.frame1` | no |
| reference images | `config.referenceImages` (3 asset or 1 style) | `characters` ids | `references` (model-specific) | `elementList` / multi-image endpoint | `subject_reference` (UNVERIFIED) | `role:'reference_image'` (up to 9) | `concepts` (effects, not images) | `reference_images` |
| video input | `video` (extend a Veo video) | extensions endpoint | `videoToVideo` (`videoUri`) | video extend, motion control `videoUrl` | no | `role:'reference_video'` (3 x 15 s) | `keyframes` type `generation`, modify video | video editing endpoint |
| duration | `durationSeconds` "4"/"6"/"8" (SDK type number) | `seconds` '4'/'8'/'12' string | `duration` number (5/10, 2..10, 4/6/8) | `duration` "5"/"10" string | `duration` 6/10 integer | `duration` integer 4..15 or 'auto' | `duration` "5s"/"9s" | `duration` 1..15 integer |
| aspect ratio | `aspectRatio` "16:9"/"9:16" | none (size implies) | `ratio` "1280:720" (pixels!) | `aspect_ratio` "16:9"/"9:16"/"1:1" | none (resolution implies) | `ratio` "16:9".."21:9", "adaptive" | `aspect_ratio` "16:9" | `aspect_ratio` 7 values |
| resolution | `resolution` "720p"/"1080p"/"4k" | `size` "1280x720" | via `ratio` | `mode` "std"/"pro" (quality tier), `4k` UNVERIFIED | `resolution` "512P".."1080P" | `resolution` "480p".."4k" | `resolution` "540p".."4k" | `resolution` "480p"/"720p"/"1080p" |
| fps | `fps` (config), output fixed 24 | no | no | no | no | no (24 fps out) | no | no |
| seed | `seed` | no | `seed` | no | no | `seed` | no | no |
| negative prompt | `negativePrompt` | no | no | `negative_prompt` | no | no | no | no |
| n | `numberOfVideos` | no | no | no | no | no | no | no |
| generate audio | `generateAudio` | always on | `audio: boolean` (Veo, Seedance, ...) | `sound` "on"/"off" (2.6+, pro) | H3 native audio, no toggle documented (UNVERIFIED) | `generate_audio` | `generate_audio` (doc page; llm-info says ray T2V/I2V "produce no native audio", conflicting) | `generate_audio` (default true) |
| input audio | no | no | `referenceAudio` (Seedance2) | lip-sync endpoint (`sound_file`, UNVERIFIED official name) | no | `role:'reference_audio'` (3 clips) | no | `reference_audios: [{voice_id}]` (voices, not files) |
| camera control | prompt text | prompt text | prompt text | `camera_control: { type, config: {horizontal, vertical, pan, tilt, roll, zoom} }` | prompt commands `[Pan left]` | `camerafixed: boolean` | prompt text | prompt text |
| enhance prompt | `enhancePrompt` | no | no | no | `prompt_optimizer` (default true), `fast_pretreatment` | no | no | no |
| watermark | no | no | no | `watermarkEnabled` (Vercel mapping) | `aigc_watermark` (UNVERIFIED, not on current doc) | `watermark` | no | no |
| callback | `webhookConfig` / `pubsubTopic` | project webhooks | no (poll) | `callback_url`, `external_task_id` | `callback_url` | `callback_url` | `callback_url` | no |
| person / safety | `personGeneration` | faces rejected | `contentModeration.publicFigureThreshold` | no | no | real faces rejected | no | `respect_moderation` in result |

Sources: https://ai.google.dev/gemini-api/docs/veo, https://developers.openai.com/api/docs/guides/video-generation, https://raw.githubusercontent.com/runwayml/sdk-node/main/src/resources/image-to-video.ts, https://raw.githubusercontent.com/aself101/kling-api/main/README.md (third-party wrapper of the official Kling API; official pages block automated fetch, so Kling names are UNVERIFIED against the primary source but match Vercel's and fal's mappings), https://platform.minimax.io/docs/api-reference/video-generation-i2v, https://platform.minimax.io/docs/api-reference/video-generation-t2v, https://platform.minimax.io/docs/api-reference/video-generation-v2-query, https://www.datacamp.com/tutorial/seedance-2-0-api-guide (secondary; the BytePlus page https://docs.byteplus.com/en/docs/ModelArk/1520757 is a JS shell), https://docs.lumalabs.ai/docs/video-generation, https://docs.x.ai/developers/model-capabilities/video/generation.

### 2.1 Recommendations per field

| Field | Verdict | Reasoning |
|---|---|---|
| `prompt` | common (string) | Universal. Keep it a plain string; dialogue conventions (quotes for Kling, block for Sora) are prompt content, not API. |
| `model` | common (provider-typed id) | Same as the other capabilities. |
| `image` (first frame) | common (`ImageBlob` or URL) | Every vendor has it, semantics match ("this is frame 0"). URL vs bytes differs per vendor; the adapter converts (fal/Kling/MiniMax want URLs or data URLs, Veo wants bytes or GCS, Sora wants multipart). Async gateways cap inline size (Vercel 300 KiB), so the type should allow a URL. |
| `lastFrame` | common, optional | Veo, Kling (pro), Runway (Veo/Seedance variants), Seedance, Luma, MiniMax all accept it and mean the same thing. Vendors that lack it should warn, not fail. Vercel modelled this as `frameImages[{frameType}]`; a named `lastFrame` field is simpler and the two are isomorphic. |
| `referenceImages` | provider-typed | Semantics diverge: Veo "asset" vs "style" tagging, Seedance `[Image 1]` prompt tokens, Grok `<IMAGE_1>`, Kling `elementList` ids, Sora character ids, Luma "concepts" are not images at all. Vercel made it common and then documented five different prompt syntaxes, which is the "don't unify what isn't unified" smell. |
| `video` (extend / v2v) | drop from the common request | Extension (Veo, Sora, Kling) takes a prior output of the same model; v2v (Runway, Luma modify, xAI editing) is a different capability with different knobs. Provider-typed at most. |
| `duration` | common (number, seconds) | Every vendor exposes it; only encoding differs (`"8s"`, `"8"`, `8`, `"4"`). Adapter maps a number to the vendor enum and fails with the allowed set when unsupported. Vercel, OpenRouter, xAI, Seedance, Nova Reel, MiniMax all use a plain number. |
| `aspectRatio` | common (`"W:H"` string) | Veo, Kling, Seedance, Luma, xAI, OpenRouter, Vercel all use `"16:9"` strings. Runway's `"1280:720"` and Sora's `size` derive from it. Keep `"W:H"`; do not add `'adaptive'` (only Seedance and Vercel). |
| `resolution` | common, as a tier enum `"480p" | "720p" | "1080p" | "4k"` | Veo, Seedance, Luma, xAI, MiniMax, OpenRouter use tier labels; Vercel and Sora use `WxH`. A tier plus aspect ratio is what most vendors want, and pixel sizes can be derived. Kling's `mode: std | pro` is a quality tier, not a resolution, so stays provider-typed. |
| `fps` | drop | Only Veo config and Nova Reel accept it, and outputs are fixed at 24 fps almost everywhere. Report it in the result instead. |
| `seed` | common, optional | Veo, Runway, Seedance, xAI, fal endpoints, Nova Reel take it. Semantics match ("best effort determinism"). Warn where unsupported. |
| `negativePrompt` | provider-typed | Only Veo and Kling (and fal wrappers). |
| `n` | drop | Only Veo `numberOfVideos`. Vercel's own comment: "Most video models only support n=1". Callers loop. |
| `audio` (generate native audio) | common, optional boolean (see 2.2) | |
| `cameraControl` | provider-typed | Kling has a structured object, Seedance has `camerafixed`, everyone else does it in prose. |
| `enhancePrompt` | provider-typed | Veo `enhancePrompt`, MiniMax `prompt_optimizer` (default true) and fal `auto_fix`. Defaults differ (Veo off, MiniMax on), so a common field would promise a behaviour it cannot deliver. |
| `watermark` | provider-typed | Seedance and MiniMax only. |
| `callbackUrl` / webhook | provider-typed, plus a core "job handle" so users can persist the id | Every vendor except Runway and xAI has some callback; payload shapes and signing differ. The library should expose start/status as first-class so any scheduler can drive it, and leave webhook receipt to the app. |
| Safety knobs (`personGeneration`, `contentModeration`, `safety_tolerance`) | provider-typed | Vendor policy, not a generation parameter. |

### 2.2 Audio, in detail

Generate-audio toggle. Native audio is now the default on the frontier models (Veo 3.x, Kling 2.6+, Seedance 2.x, Sora 2, MiniMax H3, Grok Imagine 1.5, Wan 2.6+), and every aggregator has a boolean for it with identical semantics (`generateAudio` in Vercel, `generate_audio` in OpenRouter, fal Veo, Seedance, Luma, xAI; `audio` in Runway; `sound: 'on' | 'off'` in Kling). Older models (Kling 2.5 and below, Runway Gen-4 Turbo, Luma Ray-2 per llm-info, MiniMax Hailuo 2.3) silently produce a mute MP4. Recommendation: a common optional `audio?: boolean` meaning "ask the model to generate a soundtrack"; adapters warn (not fail) when the model cannot, and the result carries `hasAudio` so callers know whether to mux a TTS or music track. Caveat: Kling only honours `sound: 'on'` in `pro` mode, and Veo's extension cannot continue audio that was absent in the last second; both belong in provider docs.

Input audio. Three distinct request shapes exist, none of which is text/image-to-video:

| Shape | Who | Inputs |
|---|---|---|
| Audio-driven talking video (image + audio) | Hedra `together/hedra-avatar` (`start_keyframe_id` + `audio_id` or inline `audio_generation: { type: 'text_to_speech', voice_id, text }`, up to 10 min), fal `fal-ai/infinitalk`, `fal-ai/bytedance/omnihuman/v1.5`, `fal-ai/wan/v2.2-14b/speech-to-video`, HeyGen avatar API, Kling "avatar" (`sound_file`, UNVERIFIED) | `image_url`, `audio_url`, optional `prompt` |
| Lip sync (video + audio) | `fal-ai/sync-lipsync/v2` (sync.so), `fal-ai/kling-video/lipsync/audio-to-video`, Runway `characterPerformance` (act_two: reference video drives a character) | `video_url`, `audio_url` |
| Audio as a reference for generation | Seedance 2.x `role: 'reference_audio'` (up to 3 clips, "background music or synchronized sound"), Runway `referenceAudio` on the Seedance2 variant, xAI `reference_audios: [{ voice_id }]` (preset voices, not files) | text/image prompt plus audio clip(s) |

Only the third shape is an extension of the ordinary request, and only Seedance implements it as a file. So: keep `audio` in the common request as the boolean toggle; model input audio as a separate `AudioBlob { bytes, format }`-typed field on a separate capability (`talking head` / `lip sync`) or as a Seedance-only provider option. That keeps a music-generation or speech-synthesis result (`AudioBlob`) composable with the audio-driven endpoints without pretending Veo can take it. All the audio-driven endpoints want a URL, so the adapter needs an upload step (fal `storage.upload`, Hedra `/assets`), which argues for the blob type carrying bytes and the adapter owning the upload.

Result side: every vendor returns one MP4 with the audio muxed in; nobody returns a separate audio track. A `VideoBlob { bytes, format: 'mp4' | 'webm', durationSeconds?, width?, height?, fps?, hasAudio? }` is enough; fal exposes `duration, fps, width, height` in metadata (Vercel puts them in `providerMetadata.fal`).

### 2.3 Job model recommendation drawn from the survey

- Core shape: `start(request) -> JobHandle` (serialisable), `status(handle) -> Pending | Completed(video) | Failed(error)`, plus a `generate(request)` convenience that loops with a Schedule and a deadline that covers the in-flight status request (the exact bug in vercel/ai#21053). Runway, Vercel, OpenRouter and OpenAI converged on this.
- Progress: expose an optional `progress?: number` (Sora, Hedra 0..1) and `queuePosition?` / `logs?` (fal, Replicate) on the pending state; do not promise them.
- Result delivery: normalise to bytes in the core; do the download in the adapter, with a size cap. Every URL is short-lived (1 h Replicate/Sora, 9 h MiniMax, 2 days Veo server-side, configurable fal, "until job expiry" OpenRouter), and OpenRouter's URLs even need the API key header. Keep the URL in provider metadata for callers who want to stream it.
- Idempotency: starting a job costs money; Vercel and OpenRouter both add an idempotency key on start and dedupe webhook retries on `<jobId>-<status>`. Worth copying for the start call.
- Timeouts: 10 minutes is the de-facto default everywhere (Vercel `timeoutMs`, Runway `waitForTaskOutput`, xAI SDK, Kling provider). Poll intervals: 5 s (Vercel, xAI), 10 s (Google, MiniMax), 10 to 20 s (OpenAI), 2 s (Replicate for short jobs).
- Inputs: accept URL or bytes for images; adapters upload bytes where the vendor wants URLs (fal storage, Hedra assets). Don't push base64 through persisted start requests (Vercel 413 at 300 KiB).

---

## Part 3: use cases and recipe candidates

### 3.1 How developers use video generation APIs

| Use case | Evidence |
|---|---|
| Marketing / ad creative at volume | Google Ads turns "up to three static images into 10-second videos" with Veo (rollout 2026-03-27, https://blog.mean.ceo/startup-news-google-veo-google-ads-2026-benefits-mistakes-steps/, UNVERIFIED secondary). eToro "using Veo to create advertising campaigns"; Agoda tests "Imagen and Veo on Vertex AI ... generate unique images of travel destinations which would then be used to generate videos" (https://cloud.google.com/transform/101-real-world-generative-ai-use-cases-from-industry-leaders/). Runway: a broadcaster's "5-person team produce 800-1,000 ads a year across 50+ studio labels" via API (https://runwayml.com/api). |
| E-commerce product videos from catalog stills | AdVon Commerce "uses Gemini and Veo to enhance product detail pages for major retailers, processing a 93,673-product catalog ... generating engaging lifestyle videos that demonstrate product functionality" (Google Cloud list above). Shutterstock integrated Runway image-to-video for customers (https://runwayml.com/customers/how-shutterstock-and-runway-are-transforming-the-future-of-creative-content). fal cites Shopify and Adobe as customers and "e-commerce product studios" (https://sacra.com/c/fal-ai/, secondary). |
| Internal / training / social clips | Monday.com "leverages Veo to produce training videos, social content, and internal communications" (Google Cloud list). |
| Storyboard / shot list to video | Google's Get_started_Veo cookbook covers text, image, first/last frame, reference and extension modes (https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_Veo.ipynb). OpenAI's Sora 2 prompting guide prescribes "shot type, subject, action, setting, and lighting" and a separate dialogue block (https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide). Open source: SainathPattipati/ai-video-generation-pipeline "Script -> Storyboard -> Characters -> Video with consistent character identity" (https://github.com/SainathPattipati/ai-video-generation-pipeline); Kling `multiShot`, Seedance multi-shot prompts. |
| Image-to-video of a generated still | The dominant production pattern (Agoda, Google Ads, Runway Shutterstock, every i2v endpoint). Keyframes from an image model give control over composition and character consistency that t2v lacks; Vercel's precedence rules and Runway's `position: 'first' | 'last'` exist for this. |
| Talking head / avatar / lip sync | Hedra avatar API (image + audio or inline TTS, up to 10 min, https://www.hedra.com/docs/pages/developer/guides/generate-avatar-video); HeyGen developer API (https://developers.heygen.com/); open source hadimouter/ai-talking-head-pipeline "Portrait photo + voice recording + transcript -> talking-head video with ... captions, using Hedra's Character-3 API" (https://github.com/hadimouter/ai-talking-head-pipeline); fal InfiniTalk, OmniHuman, Wan S2V, sync-lipsync. |
| Explainer / faceless shorts (TTS + captions + b-roll) | Remotion-based pipelines: "turns any topic into a black-canvas motion-graphics explainer video with TTS voiceover, subtitles" (Claude Code skill), "AI video generation workflow with script, slides, TTS, subtitles, and FFmpeg rendering" (GitHub topic search https://github.com/topics/ai-video-generation?o=desc&s=stars), OpenMontage "agentic video production system" (https://tosea.ai/blog/openmontage-agentic-video-production-guide, secondary). Pattern: AI clips for b-roll, Remotion or FFmpeg for assembly and captions. |
| Music video from a generated song | Suno-to-video products (freebeat, revid, SunoMV) and a BeatAPI write-up on the async workflow (https://dev.to/hao_kang_82922526dfe5d934/from-a-suno-track-to-a-hosted-music-video-designing-the-async-workflow-pm1); no open-source reference implementation found. Beat sync needs audio analysis and a compositor, not just a video model. |
| Film previs / storyboards / animatics | Runway and Lionsgate (custom model, "pre-visualization, storyboarding and final-frame production", https://runway.com/news/company-news/runway-and-lionsgate-expand-partnership) and AMC Networks (marketing and development). Directors "mock up shot ideas before committing to physical setups" (https://aiwiki.ai/wiki/runway_gen_4, secondary). |
| Game assets | No API-level evidence found. Video models produce clips, not sprite sheets or loops with alpha; Luma `loop: true` is the only relevant knob. UNVERIFIED negative. |

Cross-cutting constraints that shape recipes:

- Clips are 4 to 15 s. Anything longer is stitching (Veo extension, Sora extensions, Kling extend) or composition (FFmpeg / Remotion).
- Real faces in input images are rejected by Sora and Seedance and gated on Veo (`personGeneration`); avatar work needs the dedicated audio-driven endpoints.
- Costs are per clip and jobs take minutes, so retries and idempotency matter more than for text.
- Every vendor's URL expires within hours; the recipe must download and persist.

### 3.2 Recipe candidates, ranked

Ranking criteria: composes the most existing effect-uai capabilities, has clear real-world demand, works with providers that will exist next month, and has a bounded scope that one `recipe.ts` can express without a compositor dependency.

1. `product-clip` (image-to-video of a generated or supplied still). Take a product photo or a prompt, optionally generate the hero still with the image generator, animate it with an i2v model (Veo 3.1, Kling, Seedance, fal), request native audio, download and save the MP4 plus a thumbnail. Composes: image generator (keyframe), video generator (i2v), optional LLM (turn a product description into a motion prompt following the Sora/Veo prompting rules). Providers: any i2v provider; Veo via Gemini API is the reference. This is the AdVon / Agoda / Google Ads pattern and exercises the whole job model (start, poll, download, expiry) with the fewest moving parts.

2. `storyboard-to-video` (script to shot list to keyframes to clips). LLM writes a shot list as structured output (shot type, subject, action, camera, duration, dialogue), the image generator renders one keyframe per shot with a shared style prompt, the video generator animates each keyframe (first frame, optionally last frame = next shot's keyframe for continuity), clips are downloaded in order; concatenation is left to the caller or a documented FFmpeg one-liner. Composes: LLM structured output, image generator, video generator with `lastFrame`. Providers: Veo or Kling (both honour last frame). Demonstrates concurrency (fan out N jobs, persist handles), per-shot retries, and why `lastFrame` is a common field.

3. `talking-head` (script to voice-over to avatar clip). LLM drafts or the caller supplies a script, speech synthesis produces an `AudioBlob`, the audio-driven video endpoint (Hedra avatar, fal InfiniTalk / OmniHuman / Wan S2V) animates a portrait to it, optional transcriber produces word timings for captions. Composes: speech synthesis, video generator (audio-driven), transcriber. Providers: Hedra or fal. This is the recipe that proves the `AudioBlob` output of one capability is a valid input of another, and it is the highest-traffic commercial use (HeyGen-style). Needs the separate audio-driven request shape from 2.2.

4. `ad-variants` (one brief, N localised social clips). LLM produces K variants of a 6 to 8 s hook for a brief and audience, the video generator renders each (t2v or i2v with a brand still), audio on, aspect ratio 9:16; results are written with a manifest of prompt, seed, cost and provider metadata for A/B testing. Composes: LLM, video generator, optional image generator. Providers: any; best with a fast tier (Veo 3.1 Fast, Kling std, Seedance Fast). Exercises `n` by looping, `seed`, idempotency keys, and cost accounting; matches the "800 to 1000 ads a year" broadcaster story.

5. `music-video` (generated song to clip sequence). Music generator produces a 30 s track, transcriber (or the music provider's metadata) yields lyric timings, LLM turns lyrics into a shot list, video generator renders 8 s clips with audio off, caller muxes the track over the concatenated clips. Composes: music generator, transcriber, LLM, video generator. Providers: any t2v plus the existing music provider. Fun and demoable, but the stitching and mux step lives outside the library, so ranked below the four that are complete inside one process.

6. `clip-extend` (long-form from one seed clip). Generate a clip, then chain extensions (Veo `video` input, Kling extend) to reach 30 to 60 s, carrying the prompt forward. Composes: video generator only. Providers: Veo 3.1 (extension at 720p) or Kling. Small and provider-specific; useful as a docs example of a provider-typed `video` input rather than as a headline recipe.

Reject list:

| Use case | Reason |
|---|---|
| Game assets (sprites, loops with alpha, textures) | No vendor produces alpha or tileable loops; only Luma has `loop`. Would be a compositor exercise, not a video-model one. |
| Video-to-video style transfer / editing | Runway Gen-4 Aleph, Luma Modify, xAI editing each have unrelated knobs; not a common capability yet. Provider-typed at best. |
| Real-person avatars from user photos | Sora and Seedance reject real faces; Veo gates it; HeyGen/Hedra have consent gates. Legal and policy surface is bigger than the code. |
| Beat-synced editing | Needs onset detection and a timeline compositor (Remotion/FFmpeg); the video model contributes nothing specific. |
| Film previs with character consistency across dozens of shots | Depends on vendor-specific reference systems (Veo asset images, Kling elements, Sora characters); no common contract. Revisit when `referenceImages` semantics converge. |
| Sora 2 provider | API removed on 2026-09-24. |

---

## Sources

SDK surfaces

- https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-video
- https://ai-sdk.dev/docs/ai-sdk-core/video-generation
- https://raw.githubusercontent.com/vercel/ai/main/packages/ai/src/generate-video/generate-video.ts
- https://raw.githubusercontent.com/vercel/ai/main/packages/provider/src/video-model/v4/video-model-v4.ts
- https://raw.githubusercontent.com/vercel/ai/main/packages/provider/src/video-model/v4/video-model-v4-call-options.ts
- https://raw.githubusercontent.com/vercel/ai/main/packages/provider/src/video-model/v4/video-model-v4-operation-start-result.ts
- https://raw.githubusercontent.com/vercel/ai/main/packages/provider/src/video-model/v4/video-model-v4-operation-status-result.ts
- https://raw.githubusercontent.com/vercel/ai/main/packages/provider/src/video-model/v4/video-model-v4-result.ts
- https://raw.githubusercontent.com/vercel/ai/main/packages/provider/src/video-model/v3/video-model-v3-call-options.ts
- https://vercel.com/docs/ai-gateway/modalities/video-generation
- https://vercel.com/kb/guide/ai-sdk-video-generation
- https://ai-sdk.dev/providers/ai-sdk-providers/klingai
- https://ai-sdk.dev/providers/ai-sdk-providers/bytedance
- https://github.com/vercel/ai/issues/21053
- https://github.com/vercel/ai/issues/21000
- https://ai.google.dev/gemini-api/docs/veo
- https://googleapis.github.io/js-genai/release_docs/classes/models.Models.html#generatevideos
- https://googleapis.github.io/js-genai/release_docs/interfaces/types.GenerateVideosConfig.html
- https://googleapis.github.io/js-genai/release_docs/interfaces/types.Video.html
- https://googleapis.github.io/js-genai/release_docs/classes/operations.Operations.html
- https://developers.openai.com/api/docs/guides/video-generation
- https://developers.openai.com/api/docs/deprecations
- https://raw.githubusercontent.com/openai/openai-node/master/src/resources/videos.ts
- https://raw.githubusercontent.com/fal-ai/fal-js/main/libs/client/README.md
- https://fal.ai/docs/model-endpoints/queue
- https://fal.ai/docs/documentation/model-apis/media-expiration
- https://fal.ai/models/fal-ai/veo3.1/api
- https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video/api
- https://fal.ai/models/fal-ai/kling-video/lipsync/audio-to-video/api
- https://fal.ai/models/fal-ai/wan/v2.2-14b/speech-to-video/api
- https://fal.ai/models/fal-ai/sync-lipsync/v2/api
- https://github.com/replicate/replicate-javascript/blob/main/README.md
- https://replicate.com/docs/topics/predictions/create-a-prediction
- https://replicate.com/docs/topics/predictions/output-files
- https://replicate.com/docs/topics/predictions/data-retention
- https://github.com/langchain-ai/langchain/issues/34387
- https://github.com/langchain-ai/langchain-google/issues/1046
- https://www.langflow.org/templates/use-langflow-to-generate-ai-videos-from-text-with-google-veo/
- https://mastra.ai/docs
- https://docs.litellm.ai/docs/videos
- https://docs.litellm.ai/docs/providers/runwayml/videos
- https://docs.litellm.ai/docs/providers/gemini/videos
- https://portkey.ai/docs/product/ai-gateway/multimodal-capabilities
- https://openrouter.ai/docs/guides/overview/multimodal/video-generation
- https://openrouter.ai/blog/announcements/video-generation/
- https://github.com/TanStack/ai/issues/707
- https://github.com/TanStack/ai/issues/705
- https://docs.dev.runwayml.com/api-details/sdks/
- https://raw.githubusercontent.com/runwayml/sdk-node/main/api.md
- https://raw.githubusercontent.com/runwayml/sdk-node/main/src/resources/image-to-video.ts
- https://docs.aws.amazon.com/nova/latest/userguide/video-gen-access.html

Vendor APIs

- https://raw.githubusercontent.com/aself101/kling-api/main/README.md (third-party wrapper; official Kling pages block fetch)
- https://useapi.net/docs/api-kling-v1/post-kling-videos-image2video-elements (third-party)
- https://platform.minimax.io/docs/api-reference/video-generation-i2v
- https://platform.minimax.io/docs/api-reference/video-generation-t2v
- https://platform.minimax.io/docs/api-reference/video-generation-v2-query
- https://www.datacamp.com/tutorial/seedance-2-0-api-guide (secondary for ModelArk schema)
- https://docs.byteplus.com/en/docs/ModelArk/1520757
- https://docs.lumalabs.ai/docs/video-generation
- https://lumalabs.ai/llm-info
- https://docs.x.ai/developers/model-capabilities/video/generation
- https://www.hedra.com/docs/pages/developer/guides/generate-avatar-video
- https://developers.heygen.com/

Use cases

- https://cloud.google.com/transform/101-real-world-generative-ai-use-cases-from-industry-leaders/
- https://runwayml.com/api
- https://runwayml.com/customers/how-shutterstock-and-runway-are-transforming-the-future-of-creative-content
- https://runway.com/news/company-news/runway-and-lionsgate-expand-partnership
- https://github.com/google-gemini/cookbook/blob/main/quickstarts/Get_started_Veo.ipynb
- https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide
- https://github.com/SainathPattipati/ai-video-generation-pipeline
- https://github.com/hadimouter/ai-talking-head-pipeline
- https://github.com/topics/ai-video-generation?o=desc&s=stars
- https://dev.to/hao_kang_82922526dfe5d934/from-a-suno-track-to-a-hosted-music-video-designing-the-async-workflow-pm1
- https://sacra.com/c/fal-ai/
- https://blog.mean.ceo/startup-news-google-veo-google-ads-2026-benefits-mistakes-steps/
