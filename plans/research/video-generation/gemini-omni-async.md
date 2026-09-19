# Subagent report: Gemini Omni async / background mode (2026-09-19)

Raw report supplementing `google-veo.md`; scope is narrow: does `gemini-omni-1.1-flash` video generation have an asynchronous mode?

## Verdict up front

The Interactions API has a first-class async mode (`background: true` on create, poll `GET /v1beta/interactions/{id}`, cancel via `POST /v1beta/interactions/{id}/cancel`), and `background` is a generic request-body field with **no model restriction stated in the API reference**. The Omni guide itself instructs you to set `background=false` for speed, which only parses if `background=true` is an accepted value for that model. The prior "synchronous only" conclusion is not supported by the primary sources; it rests on a non-exhaustive "such as" sentence in the background-execution guide.

What remains UNVERIFIED: no Google doc shows a worked `gemini-omni-1.1-flash` + `background: true` example, and no page states the acceptance explicitly. Not live-tested (no API call was made from this session).

## 1. The `background` parameter on `POST /v1beta/interactions`

From the Interactions API reference, `Creating an interaction` -> `Request Body` (https://ai.google.dev/api/interactions):

> - **background** (`boolean`) Input only. Whether to run the model interaction in the background.

That is the entire specification. There is no "only supported for models X, Y" qualifier on the field, no per-model note, and no error documented for unsupported models. The same one-line definition appears on the alternate reference page https://ai.google.dev/api/interactions-api ("background boolean (optional) Input only. Whether to run the model interaction in the background.").

The only model-scoping statement anywhere is in the background execution guide (https://ai.google.dev/gemini-api/docs/background-execution):

> Background execution is supported for standard Gemini models (such as `gemini-3.8-flash` and `gemini-3.1-pro-preview`) and Managed Agents (such as `antigravity-preview-09-2026`).

Note the construction: "standard Gemini models (**such as** ...)". Both parentheticals are explicitly non-exhaustive examples, not allowlists. The sentence excludes Omni only if Omni is not a "standard Gemini model", which the docs never say. The same guide's "Use cases" section lists agents, deep research and long reasoning, and does not mention media generation, so it is fair to say background execution was written for agentic workloads. It does not say media models are rejected.

Counter-evidence that Omni does accept the field, from the Omni guide's Best practices section (https://ai.google.dev/gemini-api/docs/omni):

> - **Optimized performance:** Set `background=false`, `store=false`, and `stream=false` for faster, synchronous unary generation. Note that setting `store=false` means the generated video won't be editable in subsequent turns using the `previous_interaction_id`.

This is the decisive sentence. It is a performance recommendation for `gemini-omni-1.1-flash`, phrased as a choice among accepted values. The Omni page is explicit elsewhere when something is rejected: its Limitations list says "Provisioned throughput is not supported", "Voice editing is not supported", "System instructions, temperature, `top_p`, stop sequences, and negative prompts are not supported". `background` does not appear in that list.

Secondary point on the reliability of the reference's model lists: the `ModelOption` enum in https://ai.google.dev/api/interactions lists `gemini-2.5-flash` through `gemini-3.8-flash`, `lyria-3-clip-preview`, `gemini-robotics-er-2-preview` and others, and **does not contain `gemini-omni-1.1-flash` at all**, even though the Omni guide passes exactly that string as `model` to `interactions.create`. The "Supported models & agents" table in https://ai.google.dev/gemini-api/docs/interactions-overview likewise omits Omni. Those lists are stale, so an omission there (and by extension in the background-execution sentence) carries little weight.

## 2. What `background: true` returns and how you poll it

From https://ai.google.dev/gemini-api/docs/background-execution:

> To let the interaction run until it completes the task on the server, set `"background": true` when creating the interaction. The API immediately returns an interaction ID, which client applications can use to poll for status, stream progress, or reconnect to a disconnected stream.

Create (REST, verbatim shape from that page, model substituted would be the Omni id):

```sh
curl -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Api-Revision: 2026-05-20" \
  -d '{ "model": "gemini-3.8-flash", "input": "...", "background": true }'
```

Poll:

```sh
curl -X GET "https://generativelanguage.googleapis.com/v1beta/interactions/YOUR_INTERACTION_ID" \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H "Api-Revision: 2026-05-20"
```

The reference documents that GET as (https://ai.google.dev/api/interactions):

> `GET https://generativelanguage.googleapis.com/v1beta/interactions/{id}`
> Retrieves the full details of a single interaction based on its `Interaction.id`.

It takes optional `stream` (boolean, default `False`) and `last_event_id` ("Optional. If set, resumes the interaction stream from the next chunk after the event marked by the event id. Can only be used if `stream` is true."). So both a plain poll and a resumable SSE attach are available on the same id.

**Persist-and-poll-from-another-process: yes.** The id is a plain opaque string (`"id": "v1_Chd..."`), the GET is keyed only by id plus API key, and storage is server-side by default. From https://ai.google.dev/gemini-api/docs/interactions-overview:

> By default, the API stores all Interaction objects (`store=true`) in order to simplify use of server-side state management features (with `previous_interaction_id`), [background execution](...) (using `background=true`) and observability purposes.
>
> - **Paid tier** : The system retains interactions for **55 days**.
> - **Free tier** : The system retains interactions for **1 day**.

and, importantly for a worker-queue design:

> However, note that `store=false` is incompatible with [background execution](...) and prevents using `previous_interaction_id` for subsequent turns.

So `background: true` forces `store: true`, which directly contradicts the Omni best-practice trio (`background=false, store=false, stream=false`); that trio is the synchronous, non-persisted fast path, and the async path is its documented opposite. There is no documented cross-process restriction: a producer can write the id to a queue and a separate consumer can GET it until it reaches a terminal state, for up to the retention window.

## 3. Status values and cancellation

Status enum, verbatim from the `Interaction` resource in https://ai.google.dev/api/interactions:

> - **status** (`enum (string)`) _(Required)_ Required. Output only. The status of the interaction.
>   Possible values:
>   - `in_progress`: The interaction is in progress.
>   - `requires_action`: The interaction requires action/input from the user.
>   - `completed`: The interaction is completed.
>   - `failed`: The interaction failed.
>   - `cancelled`: The interaction was cancelled.
>   - `incomplete`: The interaction is completed, but contains incomplete results (e.g. hitting max_tokens).
>   - `budget_exceeded`: Deprecated: Token and execution budget exhaustion returns INCOMPLETE (11).
>   - `queued`: The interaction is queued, waiting for processing.

Three values beyond the five mentioned in the task brief: `incomplete`, `queued`, and the deprecated `budget_exceeded`. The background-execution guide only documents the first five, so a client must treat `queued` and `incomplete` as reachable (the guide's own polling loop is `while interaction.status == "in_progress"`, which would exit early on `queued`; that loop is a doc simplification, not a safe pattern). The SSE `interaction.status_update` event carries the same enum minus `queued`.

**Cancel endpoint: yes.** From https://ai.google.dev/api/interactions:

> `POST https://generativelanguage.googleapis.com/v1beta/interactions/{id}/cancel`
> Cancels an interaction by id. This only applies to background interactions that are still running.

And from https://ai.google.dev/gemini-api/docs/background-execution:

> - **Cancel (`POST /interactions/{id}/cancel`):** Stops the running task. The status transitions to `cancelled`. Clean-up actions on the server can cause a slight delay before the status updates in GET requests.
> - **Delete (`DELETE /interactions/{id}`):** Removes the interaction records from the server. Subsequent GET requests return a `404 Not Found` error.

Note "This only applies to background interactions that are still running": cancel is meaningless without `background: true`, another sign that the sync path has no handle to abort.

Chaining constraint relevant to Omni's multi-turn editing (same page):

> 1. **Active executions are blocked:** Chaining a subsequent interaction to one with `in_progress` status returns a `400 Bad Request` error. Wait for the interaction to reach the `completed` state before starting the next one.

So background plus `previous_interaction_id` conversational editing is legal, but serialized.

## 4. Other async paths for Omni video

- **Operations-style LRO / `predictLongRunning`: no, that is the Veo path, not Omni.** https://ai.google.dev/gemini-api/docs/veo uses `POST .../models/veo-3.1-generate-preview:predictLongRunning` plus `client.operations.get(operation)` polling. Omni is documented exclusively through `interactions.create`. No `operations` endpoint appears anywhere in the Omni guide or the Interactions reference.
- **Batch API: no.** https://ai.google.dev/gemini-api/docs/interactions-overview lists, under features supported by `generateContent` but "**not yet available** in the Interactions API":

  > - **[Batch API](https://ai.google.dev/gemini-api/docs/batch-api)**

  Since Omni is only reachable through the Interactions API, Batch is unavailable to it. Corroborating: https://ai.google.dev/gemini-api/docs/batch-api contains **zero occurrences** of the strings "omni" or "video"; it is `models/{model}:batchGenerateContent` only, and its own note says "Batch API supports a range of Gemini models. Refer to the [Models page](https://ai.google.dev/gemini-api/docs/models) for each model's support of Batch API." The Omni model card (https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash) does not mention Batch API support.

- **Streaming as a third option: yes, and it is the timeout workaround that is unambiguously documented for media.** The SSE schema in https://ai.google.dev/api/interactions defines `VideoDelta` (mime types `video/mp4` etc.), plus `ProcessingCallDelta` ("Streaming delta for a server-initiated media processing step") and `ProcessingResultDelta`, alongside `interaction.created`, `interaction.status_update`, `step.start`, `step.delta`, `step.stop`, `interaction.completed`. The Omni guide's note on `delivery: "uri"` confirms video flows over SSE: "The `uri` field is only guaranteed to be present in the initial creation response or Server-Sent Events (SSE) stream." A long `stream: true` request keeps the connection alive but is still one process holding one socket, so it is not equivalent to a persistable job id.

## 5. What `delivery: "uri"` actually changes about timing

It changes the transport of the bytes, **not** when the create call returns. From https://ai.google.dev/gemini-api/docs/omni:

> Use the `delivery="uri"` parameter in `response_format` to retrieve generated videos that are larger than 4MB. This returns a Google-hosted URI that you can poll until the video is `ACTIVE` before downloading.

The documented raw response for a URI-delivery create still carries `"status": "completed"` with the `model_output` step already populated with a `video` content part holding the `uri`. The subsequent polling in every sample is against the **Files API**, not the interaction:

```sh
STATUS_JSON=$(curl -s -X GET "https://generativelanguage.googleapis.com/v1beta/files/$FILE_ID?key=$API_KEY")
STATE=$(echo $STATUS_JSON | jq -r '.state')   # ACTIVE | FAILED | (else wait 5s)
```

So the sequence is: create blocks for the generation, returns `completed` with a file URI, and the file may still need to finish processing before download. The file-level wait is a tail, not a replacement for the generation wait. `delivery: "uri"` is a payload-size fix (over 4MB, i.e. above 720p), not an async mechanism.

There is also a documented inconsistency worth encoding in any client:

> **Note:** Currently, calling `GET /v1beta/interactions/{id}` returns the video as inline base64 data in the `data` field, even if the interaction was originally created with `delivery: "uri"`. The `uri` field is only guaranteed to be present in the initial creation response or Server-Sent Events (SSE) stream.

This matters directly for a background design: if you poll a background Omni interaction to `completed` and then GET it, you should expect **inline base64**, not a URI, regardless of what you requested. For a large (1080p/4K) video that could be a very large response body. UNVERIFIED how that interacts with the over-4MB inline limit that motivated `delivery: "uri"` in the first place; the docs do not reconcile the two.

## 6. Documented timeout / max duration for a synchronous Omni create

**No Omni-specific timeout or max duration is documented anywhere.** The only relevant numbers:

- Generic HTTP limit, from https://ai.google.dev/gemini-api/docs/background-execution: "connection timeouts can interrupt standard HTTP requests (which typically close after 60 seconds)". Note "typically", and this is the guide's motivation for background mode, not a hard API contract.
- Omni's Technical details (https://ai.google.dev/gemini-api/docs/omni): "Video generation times vary based on duration, resolution, and current API load. Longer and higher-resolution videos take more time to generate." No figure given.
- Output bounds, from the model card (https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash): "**Output video** 3s-10s (360p/720p/1080p/4K, 24 FPS)". 1080p and 4K are produced by upscaling, per the 2026-08-27 changelog entry.

The tension is unresolved in Google's own docs and is the strongest structural argument that an async path must exist for Omni: a doc-stated ~60s HTTP close, versus an unbounded synchronous generate-plus-upscale to 4K. UNVERIFIED which side gives (a longer server-side deadline for this endpoint, or clients being expected to use `stream: true` / `background: true`).

## Practical read for effect-uai

1. Model the Omni call with `background` as an optional flag, defaulting to the documented fast path (`background: false`, `store: false`, `stream: false`) for short 720p clips.
2. For an async job shape, `background: true` implies `store: true` (they are documented as incompatible with `store: false`), which in turn keeps `previous_interaction_id` editing available. The persisted handle is the interaction id; the poll is `GET /v1beta/interactions/{id}`; the abort is `POST /v1beta/interactions/{id}/cancel`; the cleanup is `DELETE /v1beta/interactions/{id}`.
3. Treat the status enum as the full eight values, not the five in the background guide. Terminal set: `completed`, `failed`, `cancelled`, `incomplete`. Non-terminal: `queued`, `in_progress`, `requires_action`.
4. Send `Api-Revision: 2026-05-20` on interactions requests; every background-execution sample includes it while the Omni samples omit it. UNVERIFIED whether it is required or merely pinning.
5. Before shipping the background path, do one live probe: `POST /v1beta/interactions` with `{"model": "gemini-omni-1.1-flash", "input": "...", "background": true}` and check whether the response is an immediate non-terminal interaction or a `400`. That single call settles the one open question.

## Sources

- https://ai.google.dev/gemini-api/docs/omni.md.txt (Gemini Omni Flash guide: best practices, URI delivery, limitations, technical details)
- https://ai.google.dev/api/interactions.md.txt (Interactions API reference: `background` field, status enum, GET, cancel, SSE event schema)
- https://ai.google.dev/api/interactions-api.md.txt (alternate rendering of the same reference)
- https://ai.google.dev/gemini-api/docs/background-execution.md.txt (background execution guide: supported-models sentence, polling and streaming patterns, cancel/delete, chaining constraints)
- https://ai.google.dev/gemini-api/docs/interactions-overview.md.txt (storage/retention, `store=false` incompatible with background, Batch API listed as not available, supported models table)
- https://ai.google.dev/gemini-api/docs/batch-api.md.txt (no occurrence of "omni" or "video"; `batchGenerateContent` only)
- https://ai.google.dev/gemini-api/docs/video.md.txt (Omni vs Veo routing)
- https://ai.google.dev/gemini-api/docs/veo.md.txt (`predictLongRunning` plus operations polling, the contrasting LRO path)
- https://ai.google.dev/gemini-api/docs/models/gemini-omni-flash.md.txt (model card: limits, versions)
- https://ai.google.dev/gemini-api/docs/models.md.txt (model id `gemini-omni-1.1-flash`)
- https://ai.google.dev/gemini-api/docs/changelog.md.txt (2026-08-27 Omni GA, 2026-06-30 Omni preview)
- https://ai.google.dev/gemini-api/docs/streaming.md.txt (agents use `background=True` and return results asynchronously)

All pages fetched 2026-09-19 as raw markdown via the `.md.txt` suffix. No live API calls were made.
