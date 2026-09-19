# Subagent report: video generation, OpenAI Sora (2026-09-19)

Raw research report, summarised in `../video-generation.md`.

## 0. Headline finding: the whole Videos API is shutting down in 5 days

The official deprecations page carries this entry (verbatim, table reproduced): "On March 24th, 2026, we notified developers using the Videos API and Sora 2 video generation model aliases and snapshots of their deprecation and removal from the API on September 24, 2026." (https://developers.openai.com/api/docs/deprecations)

| Shutdown date | Model / system          | Recommended replacement      |
| ------------- | ----------------------- | ---------------------------- |
| 2026-09-24    | Videos API              | (none, the column is a dash) |
| 2026-09-24    | `sora-2`                | (none)                       |
| 2026-09-24    | `sora-2-pro`            | (none)                       |
| 2026-09-24    | `sora-2-2025-10-06`     | (none)                       |
| 2026-09-24    | `sora-2-2025-12-08`     | (none)                       |
| 2026-09-24    | `sora-2-pro-2025-10-06` | (none)                       |

The help center confirms both dates: "The Sora web and app experiences were discontinued on April 26, 2026." and "The Sora API will be discontinued on September 24, 2026." It adds that after the shutdown "we will permanently delete any data associated with your use of Sora." (https://help.openai.com/en/articles/20001152-what-to-know-about-the-sora-discontinuation)

Both official SDKs mark every `videos.*` method `@deprecated The Sora API is scheduled to permanently shut down on September 24, 2026.` (openai-node `src/resources/videos.ts`, openai-python `src/openai/resources/videos.py`). There is no successor video model or endpoint on OpenAI's API as of today, and no Responses API video tool (section 12).

Implication for effect-uai: an `@effect-uai/openai` Sora adapter would be dead on arrival. The rest of this report is still useful as a reference design for the job-based (create, poll, download) shape that other providers copy, and as a record of a well-specified wire format.

## 1. Model ids and availability

| Id                      | Kind     | Notes                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sora-2`                | alias    | Points to `sora-2-2025-12-08` since 2026-01-13 (changelog: "Updated the sora-2 slug to point to sora-2-2025-12-08. If you need the previous model snapshot, use sora-2-2025-10-06."). Model page: "Flagship video generation with synced audio", sizes 720x1280 / 1280x720, $0.10 per second, input text + image, output video + audio. |
| `sora-2-2025-12-08`     | snapshot | Current default for `sora-2`.                                                                                                                                                                                                                                                                                                           |
| `sora-2-2025-10-06`     | snapshot | Launch snapshot (DevDay, 2025-10-06).                                                                                                                                                                                                                                                                                                   |
| `sora-2-pro`            | alias    | Points to `sora-2-pro-2025-10-06`. Model page: sizes 720x1280 / 1280x720, 1024x1792 / 1792x1024, 1080x1920 / 1920x1080.                                                                                                                                                                                                                 |
| `sora-2-pro-2025-10-06` | snapshot | Only pro snapshot.                                                                                                                                                                                                                                                                                                                      |

Sources: https://developers.openai.com/api/docs/models/sora-2, https://developers.openai.com/api/docs/models/sora-2-pro, https://developers.openai.com/api/docs/changelog.

Timeline (changelog): 2025-10-06 "Launched v1/videos for rich, detailed, and dynamic video generation and remixing with our latest Sora 2 and Sora 2 Pro models." 2026-01-13 alias bump. 2026-03-12 "Expanded the Sora API with reusable character references, longer generations up to 20 seconds, 1080p output for sora-2-pro, video extensions, and Batch API support for POST /v1/videos." Same day: "Added POST /v1/videos/edits for editing existing videos. This will replace POST /v1/videos/{video_id}/remix, which will be deprecated in 6 months." 2026-03-24 deprecation notice, shutdown 2026-09-24.

Availability: GA on the API since 2025-10-06 (no preview flag in docs), now in its final week. Nothing newer than `sora-2-pro` exists on the OpenAI API; no "sora-3" anywhere in official docs.

Model pages list the supported endpoint as `v1/videos` only; all other endpoints (chat, responses, realtime, images, batch in the model table) are "not supported" for these models. Note the Batch API accepts `POST /v1/videos` request lines (section 2) even though the model page matrix does not tick Batch.

## 2. Endpoints

Base URL `https://api.openai.com/v1`. Auth is the standard `Authorization: Bearer $OPENAI_API_KEY` header (bearerAuth in the SDK). Source for all rows: https://developers.openai.com/api/reference/resources/videos (markdown at `.../videos.md`) plus https://developers.openai.com/api/docs/guides/video-generation.

| Endpoint           | Method + path                                 | Body encoding                                                                                                                                           | Returns                                                                                                                   |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Create video       | `POST /videos`                                | JSON or `multipart/form-data` (multipart required to upload `input_reference` bytes; JSON form takes `input_reference` as `{file_id}` or `{image_url}`) | `video` object                                                                                                            |
| Retrieve (poll)    | `GET /videos/{video_id}`                      | none                                                                                                                                                    | `video` object                                                                                                            |
| List               | `GET /videos?after=&limit=&order=asc          | desc`                                                                                                                                                   | none                                                                                                                      | `{ object: "list", data: Video[], first_id, last_id, has_more }` (cursor page) |
| Delete             | `DELETE /videos/{video_id}`                   | none                                                                                                                                                    | `{ id, deleted: true, object: "video.deleted" }`. "Permanently delete a completed or failed video and its stored assets." |
| Download content   | `GET /videos/{video_id}/content?variant=video | thumbnail                                                                                                                                               | spritesheet`                                                                                                              | none                                                                           | binary stream. SDK sends `Accept: application/binary`. |
| Remix (legacy)     | `POST /videos/{video_id}/remix`               | JSON `{ prompt }` (SDK uses maybe-multipart)                                                                                                            | `video` object with `remixed_from_video_id` set. Being replaced by edits.                                                 |
| Edit               | `POST /videos/edits`                          | JSON `{ prompt, video: { id } }` or multipart with `video=@file.mp4` plus `model`                                                                       | `video` object                                                                                                            |
| Extend             | `POST /videos/extensions`                     | JSON `{ prompt, seconds, video: { id } }` (SDK also allows an uploaded video file)                                                                      | `video` object; `seconds` on the result is the stitched total                                                             |
| Create character   | `POST /videos/characters`                     | `multipart/form-data`: `name`, `video=@clip.mp4;type=video/mp4`                                                                                         | `{ id, created_at, name }`                                                                                                |
| Retrieve character | `GET /videos/characters/{character_id}`       | none                                                                                                                                                    | `{ id, created_at, name }`                                                                                                |

There is no list or delete for characters in the reference. There is no streaming endpoint (section 6).

Batch API: "Batch currently supports POST /v1/videos only." "Batch requests must use JSON, not multipart." "Batch-generated videos are available for download for up to 24 hours after the batch completes." JSONL line example from the guide:

```jsonl
{
  "custom_id": "shot-001",
  "method": "POST",
  "url": "/v1/videos",
  "body": {
    "model": "sora-2-pro",
    "prompt": "Slow dolly shot through a miniature paper city at blue hour, soft fog, practical window lights flickering on.",
    "size": "1920x1080",
    "seconds": "20"
  }
}
```

The guide also says batch output video jobs "have already reached a terminal state such as completed, failed, or expired", so `expired` is a terminal state you can see via Batch even though the `video.status` enum in the reference only lists four values.

## 3. Request parameters

Reference (https://developers.openai.com/api/reference/resources/videos) for `POST /videos`:

| Field             | Type                                                     | Allowed values                                                                                                                          | Default    | Notes                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`          | string                                                   | free text                                                                                                                               | required   | Only required field.                                                                                                                                                                                                                                              |
| `model`           | string                                                   | `sora-2`, `sora-2-pro`, `sora-2-2025-10-06`, `sora-2-pro-2025-10-06`, `sora-2-2025-12-08`                                               | `sora-2`   | Doc text: "allowed values: sora-2, sora-2-pro".                                                                                                                                                                                                                   |
| `seconds`         | string (yes, a string)                                   | reference enum: `"4"`, `"8"`, `"12"`. Guide, cookbook and extensions endpoint: `"4"`, `"8"`, `"12"`, `"16"`, `"20"`                     | `"4"`      | See enum drift note below.                                                                                                                                                                                                                                        |
| `size`            | string `WxH`                                             | reference enum: `720x1280`, `1280x720`, `1024x1792`, `1792x1024`. Guide and cookbook add `1080x1920`, `1920x1080` for `sora-2-pro` only | `720x1280` | Per-model table below.                                                                                                                                                                                                                                            |
| `input_reference` | multipart file, or JSON `{ file_id }` or `{ image_url }` | `image/jpeg`, `image/png`, `image/webp`                                                                                                 | none       | "acts as the first frame of your video". "The image must match the target video's resolution (size)." `image_url` is "A fully qualified URL or base64-encoded data URL." "Provide exactly one of image_url or file_id." Image only; no video reference on create. |
| `characters`      | array of `{ id }`                                        | up to two character ids                                                                                                                 | none       | Guide and cookbook only; not in the reference page or SDK `VideoCreateParams` yet. "Mention the character name verbatim in your prompt." Can be combined with `input_reference`.                                                                                  |

Per-model `size` (cookbook, https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide, confirmed by the model pages and the pricing table):

| Model        | Sizes                                                                      |
| ------------ | -------------------------------------------------------------------------- |
| `sora-2`     | `720x1280`, `1280x720`                                                     |
| `sora-2-pro` | `720x1280`, `1280x720`, `1024x1792`, `1792x1024`, `1080x1920`, `1920x1080` |

Enum drift note: the API reference page and both SDKs (`VideoSeconds = "4" | "8" | "12"`, `VideoSize` without 1080p) were not regenerated after the 2026-03-12 expansion, while the guide ("Both sora-2 and sora-2-pro support 16- and 20-second generations", "Use sora-2-pro when you need 1080p exports in 1920x1080 or 1080x1920"), the cookbook (`"4"`, `"8"`, `"12"`, `"16"`, `"20"`), the batch JSONL example (`"seconds":"20"`, `"size":"1920x1080"`) and the extensions endpoint reference (`allowed values: 4, 8, 12, 16, 20`) all show the wider set. Treat the wider set as the live behaviour; a client schema should accept `"16"`/`"20"` and the 1080p sizes. The pricing page also lists 1080p for `sora-2-pro`.

Knobs that do NOT exist on the wire (checked reference, guide, both SDKs): no `seed`, no `n` (one video per job), no audio on/off toggle, no negative prompt, no fps, no aspect-ratio field (aspect is implied by `size`), no `webhook` field on the request (webhooks are configured per project in the dashboard), no `user`/`metadata`. Dialogue, SFX and ambience are steered purely through the prompt (cookbook: "Dialogue must be described directly in your prompt. Place it in a <dialogue> block below your prose description").

Other endpoints' bodies:

- `POST /videos/edits`: `prompt` (string, "how to edit the source video") and `video` (`{ id }` of a completed video, or an uploaded MP4 in multipart, in which case `model` must be set: "If you upload a new video instead of editing an existing generation, set model explicitly in the request."). "If you pass a video ID, the API infers the model from the source video." Guide: "Editing uploaded videos is only available to eligible customers."
- `POST /videos/extensions`: `prompt`, `seconds` (`"4"` to `"20"`, "Length of the newly generated extension segment"), `video` (`{ id }`). "Each extension can add up to 20 seconds. A single video can be extended up to six times, for a maximum total length of 120 seconds. Extensions currently accept only a source video and prompt. They don't support characters or image references."
- `POST /videos/{video_id}/remix`: `prompt` only ("Updated text prompt that directs the remix generation").
- `POST /videos/characters`: multipart `name` (string) and `video` (file). Guide: clips "work best with short 2- to 4-second clips in 16:9 or 9:16, at 720p to 1080p"; "Character uploads that depict human likeness are blocked by default."

## 4. Job lifecycle

`video` object (reference, identical in openai-node `Video` and openai-python `Video`):

| Field                   | Type                                                   | Meaning                                                                                           |
| ----------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `id`                    | string                                                 | `video_...`                                                                                       |
| `object`                | `"video"`                                              |                                                                                                   |
| `model`                 | string                                                 | model that produced the job                                                                       |
| `status`                | `"queued" \| "in_progress" \| "completed" \| "failed"` | "Current lifecycle status of the video job." Batch output may also show `expired`.                |
| `progress`              | number                                                 | "Approximate completion percentage for the generation task." 0 to 100.                            |
| `prompt`                | string or null                                         |                                                                                                   |
| `created_at`            | number                                                 | Unix seconds                                                                                      |
| `completed_at`          | number or null                                         | Unix seconds                                                                                      |
| `expires_at`            | number or null                                         | "Unix timestamp (seconds) for when the downloadable assets expire, if set."                       |
| `seconds`               | string                                                 | "Duration of the generated clip in seconds. For extensions, this is the stitched total duration." |
| `size`                  | string                                                 | resolution                                                                                        |
| `remixed_from_video_id` | string or null                                         | set for remixes; the reference does not document an equivalent for edits or extensions            |
| `error`                 | `VideoCreateError` or null                             | see below                                                                                         |

`VideoCreateError` (reference and SDKs):

```json
{
  "code": "string, machine-readable",
  "message": "string, human-readable",
  "misalignment": {
    "detailed_explanation": "optional string",
    "error_type": "optional; potentially_unintended_data_transfer | potentially_unintended_data_access | potentially_unintended_destructive_activity | other | any string",
    "steer": { "message": "optional public continuation instruction" }
  }
}
```

The `misalignment` sub-object reuses the generic `SafetyAlertErrorType` and is documented with "clients must accept additional values". The docs do not enumerate concrete `code` values for video failures (for example for moderation blocks). UNVERIFIED: third-party write-ups mention moderation-related codes, but none appear in the official reference.

Polling guidance (guide): "Poll at a reasonable interval (for example, every 10-20 seconds), use exponential backoff if necessary." SDK samples poll every 2 s. `create_and_poll` exists in openai-python; openai-go has `NewAndPoll`.

Expiry: two different windows are documented. Guide: "Download URLs are valid for a maximum of 1 hour after generation. If you need long-term storage, copy the file to your own storage system promptly." Batch: "Batch-generated videos are available for download for up to 24 hours after the batch completes." The `expires_at` field carries the actual value per job. So yes, the client must download within a window; a library should surface `expires_at` and not cache the id as a durable handle.

Latency: no numeric SLA. Guide: "Depending on model, API load and resolution, a single render may take several minutes." and "Longer durations and 1080p jobs can take materially longer to complete than short 720p or 480p renders" (that sentence mentions 480p although no 480p size is offered).

## 5. Webhooks

Guide: "When a job finishes, the API emits one of two event types: `video.completed` and `video.failed`. Each event includes the ID of the job that triggered it." Example payload from the guide:

```json
{
  "id": "evt_abc123",
  "object": "event",
  "created_at": 1758941485,
  "type": "video.completed",
  "data": { "id": "video_abc123" }
}
```

Registration: per project, in the dashboard at https://platform.openai.com/settings/project/webhooks (name, public URL, event types). Signature headers `webhook-id`, `webhook-timestamp`, `webhook-signature` (Standard Webhooks HMAC, `v1,` prefix); SDKs expose `client.webhooks.unwrap(body, headers, secret)`. Retries with exponential backoff for up to 72 hours; `webhook-id` is the idempotency key. (https://developers.openai.com/api/docs/guides/webhooks)

Gap: the official webhook events reference (https://developers.openai.com/api/reference/resources/webhooks) lists `response.*`, `batch.*`, `fine_tuning.job.*`, `eval.run.*`, `realtime.call.incoming`, `live.*`, `safety.*` and no `video.*` events, and neither SDK ships a `VideoCompletedWebhookEvent` type. A community thread (https://community.openai.com/t/sora-video-api-webhooks-missing-discrepancy-between-documentation-and-dashboard/1361291) reported in Oct 2025 that the dashboard did not offer the video events; an OpenAI staff reply said "The webhook options should now work as expected." So the events exist per the guide but are undocumented in the reference. Payload carries only the id; you still `GET /videos/{id}` for status and error.

## 6. Streaming or progressive delivery

None. The guide's only delivery path is "Once the job has reached the completed state you can fetch the final MP4 file with GET /videos/{video_id}/content", and the reference has no SSE or chunked-progress endpoint; the only intermediate signal is the integer `progress` field on `GET /videos/{video_id}`. The `thumbnail` and `spritesheet` variants are documented for completed videos ("For each completed video, you can also download a thumbnail and a spritesheet"), not as in-flight previews. (https://developers.openai.com/api/docs/guides/video-generation)

## 7. Audio

Yes, native. Model pages list output modalities "video, audio" and describe `sora-2` as "Flagship video generation with synced audio" (https://developers.openai.com/api/docs/models/sora-2). The Sora 2 launch post: "synchronized dialogue and sound effects" and "sophisticated background soundscapes, speech, and sound effects with a high degree of realism" (https://openai.com/index/sora-2/). There is no request field to disable audio; the cookbook's advice for silent shots is prompt-side ("If your shot is silent, you can still suggest pacing with one small sound, such as 'distant traffic hiss'").

Container: MP4 ("fetch the final MP4"). Thumbnail is WebP, spritesheet is JPG (guide's curl output names `thumbnail.webp`, `spritesheet.jpg`). Video and audio codecs are not documented; UNVERIFIED (H.264 + AAC is the common assumption in third-party posts).

## 8. Remix, edit, extend, video-to-video

Three distinct endpoints, not one endpoint with a mode field:

| Operation      | Endpoint                                                                  | Input                                                           | What it does                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remix (legacy) | `POST /videos/{video_id}/remix` with `{ prompt }`                         | completed video id                                              | "Create a remix of a completed video using a refreshed prompt." Result carries `remixed_from_video_id`. Being replaced: "This will replace POST /v1/videos/{video_id}/remix, which will be deprecated in 6 months" (from 2026-03-12). |
| Edit           | `POST /videos/edits` with `{ prompt, video: { id } }` or multipart upload | completed video id, or an uploaded MP4 for "eligible customers" | "the system reuses the original structure, continuity, and composition while applying the modification". Same output length; targeted change.                                                                                         |
| Extend         | `POST /videos/extensions` with `{ prompt, seconds, video: { id } }`       | completed video id                                              | "generates the next segment using the full source clip as context" and returns a stitched video; up to 6 extensions, 120 s total.                                                                                                     |

Video as a reference on `POST /videos` is not supported: `input_reference` is image-only ("ImageInputReferenceParam", formats jpeg/png/webp). The guide's Batch section mentions "Multipart input_reference uploads, including video reference inputs, aren't supported in Batch", which hints at a video reference input path in multipart mode, but neither the reference nor the guide documents it; UNVERIFIED. True video-to-video with your own footage is the multipart edits upload, gated to eligible customers.

Note the cookbook lists the edit endpoint as `POST /v1/videos/{video_id}/edits`; the reference and the guide both use `POST /v1/videos/edits` with the id in the body. Trust the reference.

## 9. Content and safety

Guide, "Guardrails and restrictions" (dashes in the original replaced with commas):

- "Only content suitable for audiences under 18 (a setting to bypass this restriction will be available in the future)."
- "Copyrighted characters and copyrighted music will be rejected."
- "Real people, including public figures, cannot be generated."
- "Character uploads that depict human likeness are blocked by default." (human-likeness access via sales)
- "Input images with faces of humans are currently rejected."

Failures surface as `status: "failed"` with an `error` object (section 4); the guide says "Make sure prompts, reference images, and transcripts respect these rules to avoid failed generations." Cameos (consented likeness) are a consumer-app feature and are not exposed on the API; the API's "characters" are explicitly non-human ("upload a reusable non-human subject").

Provenance: OpenAI's launch-safety post states "Every video generated with Sora includes both visible and invisible provenance signals. At launch, all outputs carry a visible watermark." and "All Sora videos also embed C2PA metadata, an industry-standard signature" (https://openai.com/index/launching-sora-responsibly/). That post is about the Sora product broadly; the API guide and reference say nothing about watermarks. UNVERIFIED: several third-party posts claim API downloads carry C2PA metadata but no visible watermark; not confirmed by any OpenAI page reachable today.

Moderation scope (same post): guardrails check "both prompts and outputs across multiple video frames and audio transcripts".

## 10. Pricing, latency, rate limits

Pricing page (https://developers.openai.com/api/docs/pricing, "Video generation models", "Prices per second"):

| Model        | Size  | Portrait  | Landscape | Standard $/s | Batch $/s |
| ------------ | ----- | --------- | --------- | ------------ | --------- |
| `sora-2`     | 720p  | 720x1280  | 1280x720  | $0.10        | $0.05     |
| `sora-2-pro` | 720p  | 720x1280  | 1280x720  | $0.30        | $0.15     |
| `sora-2-pro` | 1024p | 1024x1792 | 1792x1024 | $0.50        | $0.25     |
| `sora-2-pro` | 1080p | 1080x1920 | 1920x1080 | $0.70        | $0.35     |

So a 20 s 1080p pro clip is $14.00 standard, $7.00 via Batch. Billing for edits, extensions and remixes is not called out separately; assume per generated second at the source video's size (UNVERIFIED).

Rate limits (model pages, requests per minute by usage tier):

| Tier | `sora-2` RPM | `sora-2-pro` RPM |
| ---- | ------------ | ---------------- |
| 1    | 25           | 10               |
| 2    | 50           | 25               |
| 3    | 125          | 50               |
| 4    | 200          | 75               |
| 5    | 375          | 150              |

Concurrency (number of in-flight jobs): not documented on any official page; UNVERIFIED (third-party posts describe a per-account concurrent-job ceiling visible in the dashboard).

Latency: "several minutes", no numbers (section 4).

## 11. Minimal JSON examples

Create (JSON body; multipart is needed only when uploading `input_reference` bytes):

```http
POST https://api.openai.com/v1/videos
Authorization: Bearer $OPENAI_API_KEY
Content-Type: application/json

{
  "model": "sora-2-pro",
  "prompt": "Wide tracking shot of a teal coupe driving through a desert highway, heat ripples visible, hard sun overhead.",
  "size": "1280x720",
  "seconds": "8"
}
```

Create with an uploaded first frame (multipart, from the guide):

```bash
curl -X POST "https://api.openai.com/v1/videos" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: multipart/form-data" \
  -F prompt="She turns around and smiles, then slowly walks out of the frame." \
  -F model="sora-2-pro" \
  -F size="1280x720" \
  -F seconds="8" \
  -F input_reference="@sample_720p.jpeg;type=image/jpeg"
```

Pending response (guide, verbatim):

```json
{
  "id": "video_68d7512d07848190b3e45da0ecbebcde004da08e1e0678d5",
  "object": "video",
  "created_at": 1758941485,
  "status": "queued",
  "model": "sora-2-pro",
  "progress": 0,
  "seconds": "8",
  "size": "1280x720"
}
```

In-progress poll response (guide): same shape with `"status": "in_progress"`, `"progress": 33`.

Completed response (composed from the reference's field list; the docs give no literal completed example):

```json
{
  "id": "video_68d7512d07848190b3e45da0ecbebcde004da08e1e0678d5",
  "object": "video",
  "model": "sora-2-pro",
  "status": "completed",
  "progress": 100,
  "prompt": "Wide tracking shot of a teal coupe ...",
  "created_at": 1758941485,
  "completed_at": 1758941790,
  "expires_at": 1758945390,
  "seconds": "8",
  "size": "1280x720",
  "remixed_from_video_id": null,
  "error": null
}
```

Failed response: same shape with `"status": "failed"` and `"error": { "code": "...", "message": "..." }`.

Download:

```bash
curl -L "https://api.openai.com/v1/videos/video_abc123/content" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  --output video.mp4

curl -L "https://api.openai.com/v1/videos/video_abc123/content?variant=thumbnail" \
  -H "Authorization: Bearer $OPENAI_API_KEY" --output thumbnail.webp
```

Oddity: the reference's second create example response includes `"quality": "standard"`, a field that does not appear in the documented `video` object or in either SDK type. Treat as an undocumented extra; a decoder should not fail on unknown fields.

## 12. Responses API hosted video tool

None. The Responses tools guide (https://developers.openai.com/api/docs/guides/tools) lists web search, file search, tool search, MCP, function calling, skills, shell, computer use and "Image generation: Generate or edit images using GPT Image" (tool type `image_generation`). No video tool exists, and the changelog never announced one. Video generation is only reachable through `/v1/videos` (and Batch lines targeting it).

## 13. Design notes for a VideoGenerator capability (observations, not decisions)

- Job shape: create returns immediately with `queued`; poll or webhook; download separately with a variant. `expires_at` and the 1 h / 24 h download windows mean the output handle is a short-lived id, not a URL.
- `seconds` is a string enum on the wire, not a number. `size` is a `WxH` string, and the allowed set depends on the model.
- Reference input is image-only and must match `size` exactly; there is no video-as-reference on create.
- Continuation is a family of three endpoints (remix, edit, extend), each taking a completed video id plus prompt. Extend adds a `seconds` segment length and returns the stitched total.
- Audio is always on and steered by prompt; there is no toggle.
- No seed, no `n`, no negative prompt.
- Errors are in-band on the job (`status: failed`, `error.code`), not HTTP errors, except for request validation.
- All of it disappears on 2026-09-24.

## Sources

- Video generation guide: https://developers.openai.com/api/docs/guides/video-generation (markdown: https://developers.openai.com/api/docs/guides/video-generation.md)
- Videos API reference: https://developers.openai.com/api/reference/resources/videos (markdown: https://developers.openai.com/api/reference/resources/videos.md)
- Create video reference: https://developers.openai.com/api/reference/resources/videos/methods/create
- Deprecations: https://developers.openai.com/api/docs/deprecations
- Changelog: https://developers.openai.com/api/docs/changelog
- Pricing: https://developers.openai.com/api/docs/pricing
- Model pages: https://developers.openai.com/api/docs/models/sora-2 and https://developers.openai.com/api/docs/models/sora-2-pro
- Webhooks guide: https://developers.openai.com/api/docs/guides/webhooks
- Webhook events reference: https://developers.openai.com/api/reference/resources/webhooks
- Responses tools guide: https://developers.openai.com/api/docs/guides/tools
- Sora 2 prompting guide (cookbook): https://developers.openai.com/cookbook/examples/sora/sora2_prompting_guide
- openai-node videos resource: https://raw.githubusercontent.com/openai/openai-node/master/src/resources/videos.ts
- openai-python videos resource and types: https://raw.githubusercontent.com/openai/openai-python/main/src/openai/resources/videos.py, https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/video.py, `video_create_params.py`, `video_seconds.py`, `video_size.py`, `video_extend_params.py`, `video_edit_params.py`, `video_create_error.py`
- Help center, Sora discontinuation: https://help.openai.com/en/articles/20001152-what-to-know-about-the-sora-discontinuation
- Sora 2 announcement: https://openai.com/index/sora-2/
- Launching Sora responsibly: https://openai.com/index/launching-sora-responsibly/
- Community thread on missing video webhook events: https://community.openai.com/t/sora-video-api-webhooks-missing-discrepancy-between-documentation-and-dashboard/1361291
