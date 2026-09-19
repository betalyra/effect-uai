# Plan: video generation

Design and implementation plan for the `VideoGenerator` capability
(issue #136). Research behind every claim:
[research/video-generation.md](./research/video-generation.md) (summary)
and [research/video-generation/](./research/video-generation/) (seven
raw reports, including the wire schemas in
[google-veo.md](./research/video-generation/google-veo.md) and
[aggregators.md](./research/video-generation/aggregators.md)).

Nothing here is implemented. Part 1 is the design. Part 2 is the
sequenced build.

---

# Part 1: Design

## Scope

A **`VideoGenerator` service** in core shaped as an explicit background
job, plus provider adapters.

**Providers, decided.**

| Provider | How | Why |
| --- | --- | --- |
| fal | new video adapter on a new queue client | One adapter reaches MiniMax H3, Dreamina Seedance, BFL FLUX 3, Kling and LTX. The fastest path to real coverage. |
| Google Gemini Omni | new adapter in `@effect-uai/google` | Google's own docs make it the default video model. |
| MiniMax | new package | Top of the image-to-video leaderboard, and the fast tier the TV station runs on. |
| ByteDance Dreamina Seedance | new package | The leading video model right now. |
| BFL | new package | Top 5 on text-to-video. |
| Runway | new package | The only one of these that fal does not host, so a package is the only way to reach it. |

**Excluded, decided.** Veo, because Google's video guide says to use
Gemini Omni Flash as the default and Veo only for scene extension and
legacy pipelines, and because dropping it removes an entire second
codec and operation model from the Google package. OpenAI Sora, removed
2026-09-24. Alibaba Wan. xAI Grok Imagine. Kling as a direct package,
though it comes free through fal.

**Audio is out of scope for v1.** No `audio` field on the request, no
`hasAudio` on the result, no audio handling in any adapter. Whatever
each model does natively, it does; we neither ask for it nor describe
it. The research found the request-side toggle is not uniform anyway
(three vendors take a boolean, one a tri-state, three always generate
audio with no toggle, two cannot generate it at all), so deferring costs
nothing and avoids promising behaviour we cannot deliver. It can be
added later as one optional field plus one result field, additively.

**Also out of scope.** Progressive frame delivery, because it does not
exist anywhere. Continuous and interactive WebRTC generation (fal
`h3-max/director`, Decart Lucy, Runway Characters), which is the
realtime archetype and belongs next to `RealtimeSession`. Audio-driven
video and lip-sync. Video-to-video restyle and edit. `extend` as a
method, deferred with its recipe. Video input to language model turns.
Upscalers. Webhook receipt, which is the application's job.

Current models only. Model unions carry the `(string & {})` tail, so a
new id works without an SDK update.

## The job question

You asked where `Job` is used today and whether hiding a poll loop
inside the capability is the right default. The investigation says no,
and the plan changes accordingly.

### What the code actually does today

`Job.ts` is used by exactly one capability, `DeepResearch`, and by three
providers through it.

| File | What it does |
| --- | --- |
| `core/src/job/Job.ts` | `JobRef`, `JobState`, `JobOps`, plus `collect` (poll to settled) and `run` (submit then collect) |
| `core/src/research/DeepResearch.ts` | `fromJob` derives the whole service from three wire ops |
| `google/src/GoogleDeepResearch.ts`, `responses/src/OpenAIDeepResearch.ts`, `perplexity/src/PerplexityDeepResearch.ts` | each supplies `submit` / `poll` / `cancel` and calls `fromJob(ops, cfg.job)` |

Your intuition was right on the first half: **no provider writes a poll
loop.** Each supplies three wire calls and nothing else. The loop lives
in core.

But the second half is the problem. `fromJob` derives a `research()`
method that calls `Job.run`, which submits and then polls to completion
behind a single `Effect`. So the hidden-polling default does exist
today, in `DeepResearch`, and copying it into video would spread it.

Worth noting: the one recipe that consumes the native capability,
`recipes/native-deep-research`, does not call the blocking `research()`
at all. It uses `researchStream`. The blocking convenience is the least
used part of the surface.

### What video should do instead

The capability hands back a job. Polling is the caller's, and it is
visible at the call site.

```ts
export type VideoGeneratorService = {
  /**
   * Start a generation. Returns as soon as the provider has accepted
   * the request. Does not poll and does not wait for the video.
   */
  readonly submit: (request: Req) => Effect.Effect<VideoJobRef, AiError.AiError>

  /** Exactly one status fetch. No loop, no retry, no schedule. */
  readonly status: (ref: VideoJobRef) => Effect.Effect<VideoState, AiError.AiError>

  /** Cancel a running job. `Unsupported` where the provider has none. */
  readonly cancel: (ref: VideoJobRef) => Effect.Effect<void, AiError.AiError>
}
```

Three methods, each one wire call. There is no `generate`.

A caller who wants to block opts in by name, and the name says loop:

```ts
// core, a free function over the tag, not a service method
export const collect = (
  ref: VideoJobRef,
  config?: Job.JobConfig,
): Effect.Effect<VideoResponse, AiError.AiError, VideoGenerator> =>
  Effect.flatMap(VideoGenerator, (s) => Job.collect(s.status, ref, config))
```

So the blocking path reads as two visible steps, and the poll cadence
and timeout are arguments rather than hidden defaults:

```ts
const ref = yield* VideoGenerator.submit({ model, prompt })
const result = yield* VideoGenerator.collect(ref, { pollInterval: "3 seconds" })
```

What this buys, concretely. A caller can submit ten clips, persist the
ten refs, and collect them from a queue worker in another process,
because `VideoJobRef` is plain `{ _tag, provider, id }` data. A caller
can drive their own schedule, or surface queue position in a UI, or
abandon a job without an interrupt handler racing a cancel. None of
that is reachable when the loop is welded inside a `generate`.

What it costs. Every caller writes two lines instead of one. That is
the whole cost, and it is the right trade for a capability where one
call can take six minutes and costs real money.

`Job.collect` already does the right thing on the two bugs the Vercel
AI SDK hit (`vercel/ai#21053`, a poll deadline that did not cover the
in-flight status request, and `#21000`, a timeout implemented as an
attempt count), because it wraps `Effect.timeoutOrElse` around the whole
repeat. No change needed there.

### Is the `Job` abstraction itself right?

Checked against what `effect@4.0.0-rc.111` actually ships. Short answer:
**the runner is idiomatic and should stay, the data types are not and
should change.**

Candidates in Effect, and whether any replaces what we hand-rolled:

| Effect primitive | What it is | Fit |
| --- | --- | --- |
| `Effect.repeat({ schedule, until })` plus `Effect.timeoutOrElse` | repeat an effect on a schedule until a predicate holds, bounded | **This is already what `Job.collect` uses.** It is the idiomatic polling loop. Not reinvented. |
| `effect/unstable/workflow`: `Workflow`, `Activity`, `DurableDeferred`, `DurableQueue`, `WorkflowEngine` | durable execution of **our own** code, with execute / poll / interrupt / resume, backed by a `WorkflowEngine` persistence layer | Wrong direction, and see the note below. Its durable state is ours to store; our durable state is the provider's, and we hold a remote handle to it. Adopting it would mean standing up a persistence backend to track work someone else is already tracking. |
| `Resource` | a value loaded into memory, refreshable manually or on a schedule | No. Caches a current value, does not model a one-shot remote job. |
| `Cache`, `ScopedCache`, `Pool`, `RcRef`, `ScopedRef` | caching and lifecycle | No. |
| `Deferred`, `Latch` | in-process completion signal | No. Dies with the process, which is the case the ref exists for. |
| `Request` / `RequestResolver` | batching and deduplicating data fetches | No, though it is the closest thing to a "handle plus resolution" shape. |
| `Data.TaggedEnum` | tagged union with generated constructors, `$is` and `$match` | **Yes, for `JobState`.** |
| `Schema` | encode and decode | **Yes, for `JobRef`.** |

So there is no Effect primitive that subsumes `JobRef` plus
`JobOps`, and the loop we wrote is the one Effect would have us write.
Three changes are still worth making.

**1. `JobState` should be a `Data.TaggedEnum`.** It is currently a
hand-rolled union, and it is the outlier: `TurnEvent`,
`ImageStreamEvent`, `MockMessenger.Call`, `MockSandbox.Call` and the
messenger's `Progress` are all `Data.TaggedEnum`. Converting gets `$is`
and `$match` for free and makes exhaustiveness a type error rather than
a convention.

Being generic in the result type costs a little ceremony, via the
`WithGenerics` and `Kind` helpers:

```ts
export type JobState<A> = Data.TaggedEnum<{
  Pending: {}
  Running: { readonly progress?: number; readonly queuePosition?: number }
  Succeeded: { readonly result: A }
  Failed: { readonly reason?: string; readonly raw?: unknown }
}>

interface JobStateDef extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: JobState<this["A"]>
}

export const JobState = Data.taggedEnum<JobStateDef>()
```

This is a low-risk change. `Data.TaggedEnum` resolves to an ordinary
structural union, so every existing `{ _tag: "Succeeded", result }`
literal in the three deep-research adapters still typechecks and every
existing `_tag === "Running"` match still narrows. The constructors are
an addition, not a migration.

**2. `JobRef` has no `Schema`, and it should.** The entire justification
for the ref being plain `{ _tag, provider, id }` data is that you can
persist it and collect it from another process. But there is no decoder,
so a ref read back out of a database or a queue message is an unchecked
cast today. A `Schema` for it closes the loop that the type was designed
to open. The phantom result-type brand stays a compile-time concern and
does not need to survive the round trip.

**3. Video does not need `JobOps`.** `JobOps` exists to feed
`DeepResearch.fromJob`, which derives a blocking method we are
deliberately not deriving. The video service already exposes `submit`,
`status` and `cancel` directly, and `collect` is a free function over
the tag, so bundling the three into an ops record buys nothing here.
Leave `JobOps` alone for `DeepResearch` and do not use it for video.

### Why the split surface is also the composable one

Worth stating because it turns a preference into an argument.
`effect/unstable/workflow`'s `Activity` is "run this step, and once it
has succeeded, remember that and do not run it again". A `generate()`
that submits and then polls internally is a poor `Activity`: a retry
after a crash cannot tell whether the submit already happened, so it
re-submits and pays for a second video.

Split into `submit` and `status`, each is a clean `Activity`. Submit
once, record the ref, poll as a separate durable step, resume after a
crash without re-paying. So the surface you asked for is also the one
that composes with Effect's own durable execution, for the users who
want that. We do not adopt `Workflow` ourselves, but we stop blocking
anyone who does.

### Every provider fits, including Gemini Omni

An earlier draft of this plan claimed Gemini Omni was synchronous only
and spent a page on how to accommodate the one provider that did not fit
a job model. That was wrong, and the correction matters enough to record
why.

**Omni has an async mode: `background: true` on the create body.** The
create call then returns an interaction id immediately, and you poll
`GET /v1beta/interactions/{id}`, abort with
`POST /v1beta/interactions/{id}/cancel`, and clean up with `DELETE`. The
id is server-stored and opaque, retained 55 days on the paid tier and 1
day on free, so it is persistable and collectable from another process,
which is exactly the contract `VideoJobRef` promises.

The earlier mistake came from reading the background-execution guide's
"supported for standard Gemini models (such as `gemini-3.8-flash` and
`gemini-3.1-pro-preview`) and Managed Agents" as an allowlist. It says
"such as". The API reference defines `background` with no model
restriction at all: "Input only. Whether to run the model interaction in
the background."

Two checks against Google's own Omni page confirm it, both verified
directly rather than taken from a report. The page says, verbatim, "Set
`background=false`, `store=false`, and `stream=false` for faster,
synchronous unary generation", which only parses if `background=true` is
a real option for this model. And the page's Limitations section is long
and specific, naming provisioned throughput, system instructions,
temperature, `top_p`, stop sequences and negative prompts as
unsupported. It never mentions `background`.

Residual uncertainty, stated plainly: no Google doc shows a worked
Omni-plus-background example, and no live call was made. Confidence is
high but not total. **One `curl` settles it, and that is the first task
of Phase 4.** If it turns out the server rejects `background: true` for
this model, the fallback is to document `submit` as blocking on Omni and
move on, which is a provider doc note rather than a design change.

So the job surface is uniform across every provider in scope. fal,
MiniMax, Dreamina, BFL and Runway all return a task id immediately, and
so does Omni with one flag set.

### What the Omni async mode costs in the adapter

Four details that shape the adapter, each a small trap.

**`background: true` requires `store: true`.** The docs say `store=false`
"is incompatible with background execution", which is the exact inverse
of the synchronous fast-path trio. A pleasant side effect: `store: true`
is also what keeps `previous_interaction_id` available for conversational
editing, so the async path and the multi-turn path want the same setting.

**The status enum has eight values, not five:** `queued`, `in_progress`,
`requires_action`, `completed`, `incomplete`, `failed`, `cancelled`, and
the deprecated `budget_exceeded`. Google's own sample loop is
`while status == "in_progress"`, which exits early on `queued` and would
report a job finished before it started. Our mapping must be explicit:
`queued` to `Pending`, `in_progress` to `Running`, `completed` to
`Succeeded`, and `incomplete` / `failed` / `cancelled` /
`budget_exceeded` / `requires_action` all to `Failed` carrying the raw
status as the reason.

That last group raises a small design question worth deciding in Phase 0:
**should `JobState` gain a `Cancelled` variant?** Today a cancelled job
lands in `Failed` with a reason string. The caller who cancelled it knows
they did, so the information is not lost, and adding a variant touches
`DeepResearch` too. Recommendation: leave it in `Failed`, revisit if a
recipe needs to distinguish.

**`delivery: "uri"` does not return early.** The create call still blocks
(in the synchronous mode) and comes back `completed`; the polling in
Google's samples is against the Files API for `ACTIVE`, not against the
generation. It is a fix for payloads over roughly 4 MB, nothing more. And
a later `GET /interactions/{id}` returns inline base64 even when the
interaction was created with `delivery: "uri"`, so the URI must be
captured from the create response.

**Chaining to an `in_progress` interaction returns 400.** Multi-turn
conversational edits must be serialised, which matters if a recipe ever
fans out edits on one interaction.

One more reliability note for whoever writes the adapter: the API
reference's `ModelOption` enum and the overview's supported-models table
both omit `gemini-omni-1.1-flash` entirely, although the Omni guide
passes exactly that string. Those lists are stale, so an omission there
proves nothing.

## Common request

Portable fields only.

```ts
export type CommonVideoGenerateRequest = {
  readonly prompt: string
  /** Each provider narrows this to its typed literal union. */
  readonly model: string
  /** First frame. Image-to-video is `submit` with this set. */
  readonly image?: ImageSource
  /** Last frame. Requires `image` on every provider that takes it. */
  readonly lastFrame?: ImageSource
  /** Adapters encode to the wire: `"8s"`, `"5"`, `8`, or a frame count. */
  readonly duration?: Duration.Duration
  readonly aspectRatio?: AspectRatio
  readonly resolution?: VideoResolution
  /** Bucket 3: honored where the provider takes one, silent elsewhere. */
  readonly seed?: number
}
```

**Duration is a `Duration.Duration`,** matching
`CommonGenerateMusicRequest.duration`, which is already a `Duration` for
the same reason. Raw numbers never appear in a public request or result
type in this codebase. Every vendor projects from a duration; only the
wire encoding differs (`"8s"`, `"5"`, `8`, `"auto"`, or `num_frames`
plus `fps`), so each adapter owns its encoding and converts at the wire
boundary.

**Aspect ratio reuses `AspectRatio` from `Media.ts`**, whose comment
already says "Shared by image and video generation". Runway's pixel
pairs and the various `"adaptive"` values stay out; the `(string & {})`
tail covers the first and `undefined` the second.

**Resolution is new and video-typed**, because `Media.ts` says "video
models tier by scan height. Each modality types its own."

**Dropped:** `n` (Veo only, and the Gemini API pins it to 1), `fps`
(24 almost everywhere, reported on the result instead), `audio` (out of
scope), `negativePrompt`, `cameraControl`, `enhancePrompt`, `watermark`
(all provider-typed).

## Output

```ts
export type GeneratedVideo = {
  readonly video: VideoSource
  readonly duration?: Duration.Duration
  readonly width?: number
  readonly height?: number
  readonly fps?: number
  /** Set only when the provider applies one. Omni sets `"synthid"`. */
  readonly watermark?: Watermark
  readonly providerData?: ProviderData
}

export type VideoResponse = {
  readonly videos: ReadonlyArray<GeneratedVideo>
  readonly usage: VideoUsage
  readonly providerData?: ProviderData
}

/** Optional throughout: fal bills per second, Google per token. */
export type VideoUsage = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
  /** What the provider says it billed for, where it says so. */
  readonly billedDuration?: Duration.Duration
}
```

Adapters return what the provider gave: a `url` for fal, inline
`base64` for Omni. No eager download, because a 4K clip is large and
many callers only want to hand the URL to a player or a CDN.

The cost is the expiry footgun, which is real and uneven: about an hour
on MiniMax V1, roughly 24 hours on Dreamina, 24 to 48 on Runway, 48 on
the Omni Files API, 30 days on Kling, configurable on fal. Mitigated
two ways. Each provider doc states its lifetime in the first screen. And
core ships a `download` helper that resolves a `url` variant into
`bytes`, provider-aware because some URIs need auth attached.

## Errors

Safety and moderation blocks map to `AiError.ContentFiltered`. A
provider settling with no video maps to `AiError.GenerationFailed`. A
job that never settles inside the timeout is `AiError.Timeout`, which
`Job.collect` already raises. Everything else follows each package's
existing helpers: `httpStatusError` and `transportFailure` in the google
codec, `httpError` and `transportFailure` in fal's.

Note for the Gemini adapter: the Gemini API returns no machine-readable
safety reason (`raiMediaFilteredCount` is Vertex only), so a filtered
generation is a `GenerationFailed` with the raw body attached rather
than a `ContentFiltered` we can justify.

## Consistency with the existing capabilities

| Convention | Where it lives today | Applied here |
| --- | --- | --- |
| One generic `Context.Service` tag, `Common*Request` with `model: string`, module-level helpers that `Effect.flatMap` the tag | every capability | `VideoGenerator`, `CommonVideoGenerateRequest`, `submit` / `status` / `cancel` / `collect` |
| Provider request = `Omit<Common, "model"> & { model: TypedUnion; ...knobs }`; one `layer` registers both tags | `FalImageGenerator`, `GeminiImageGenerator` | `FalVideoGenerator`, `GeminiOmniVideoGenerator` |
| Background job ops are `submit` / `poll` / `cancel`, and core owns the loop | `Job.ts`, `DeepResearch.fromJob` | same ops, but **no derived blocking method** |
| Optional methods gated by a `void` marker tag | `SttStreaming`, `ImageStreaming` | none in v1; `DetachableVideoJob` is the escalation if option 3 above is taken |
| No per-model capability tables. Send it, translate the error | capabilities-plan §2.3 | resolution and duration limits are the server's call |
| `Config = { apiKey, baseUrl?, job? }` | `GoogleDeepResearch.Config` | same on every adapter |
| Per-item and per-response `providerData` with a typed reader | `FalImageGenerator.imageDataOf` | `videoDataOf` / `responseDataOf` |
| Docs: `docs/<capability>/index.md` plus `providers/<provider>.md` | `docs/image-generation/` | same, each provider page leading with URL lifetime |

---

# Part 2: Implementation plan

Ordered so that something demoable exists as early as possible, and so
that each phase is independently shippable. The TV station is phase 3
on purpose: it is the proof that the whole design works, and it is the
most fun thing to have running.

## Phase 0: lock the open decisions

No code. Resolve, in this document:

1. Whether `JobState` gains a `Cancelled` variant or cancellation stays
   in `Failed` with a reason. Recommendation: stays in `Failed`.
2. Whether Kling gets a direct package eventually or stays fal-only.

**Decided:** duration is always a `Duration.Duration`, on the request,
on `GeneratedVideo` and on `VideoUsage`. No raw seconds in any public
type; adapters convert at the wire boundary.

## Phase 1: core primitives

- `core/src/domain/Video.ts`: `VideoMimeType`, `VideoSource` as
  `MediaSource<VideoMimeType>`, `VideoResolution`, `GeneratedVideo`,
  constructors and guards mirroring `Image.ts`.
- `core/src/domain/Media.ts` and `Image.ts`: move `ProviderData` to
  `Media.ts`, re-export from `Image.ts`. Same move `Watermark` already
  had, for the same reason.
- `core/src/job/Job.ts`, three changes, all additive and all landing
  before any video code depends on them:
  - Convert `JobState` to a `Data.TaggedEnum` via `WithGenerics<1>`, per
    the analysis above. The resulting type is still a structural union,
    so the three deep-research adapters need no edits.
  - Add optional `progress` and `queuePosition` to `Running`.
  - Add a `Schema` for `JobRef`, so a ref persisted to a database or a
    queue can be decoded back rather than cast.

  These three are worth landing as their own change, reviewable on its
  own, because they touch `DeepResearch` as well. Its tests should pass
  untouched, which is the check that the conversion really was additive.
- `core/src/video-generator/VideoGenerator.ts`: the tag, the common
  request and response types, `submit` / `status` / `cancel` accessors,
  and the `collect` free function.
- `core/src/video-generator/download.ts` or a method on the service:
  resolve a `url` `VideoSource` into `bytes`.
- Package exports for `./Video` and `./VideoGenerator`, plus
  `core/src/index.ts`.

Deliverable: the capability compiles and has no providers. Tests cover
`collect`'s settle and timeout behaviour against a fake `status`.

## Phase 2: fal, the queue client and the video adapter

This is the phase that unlocks most of the provider list at once.

- `providers/fal/src/queue.ts`: submit, status (with `logs` and
  `queue_position`), result, cancel against `https://queue.fal.run`,
  plus the `X-Fal-*` headers. The existing image adapter is sync-only
  against `fal.run` and has none of this. Written as its own module so
  any future fal capability reuses it.
- `providers/fal/src/FalVideoGenerator.ts`: endpoint-as-model exactly
  as the image adapter does it, output envelope decode
  (`{ video: { url, content_type, file_name, file_size } }` plus the
  optional `width` / `height` / `fps` / `duration` superset),
  `providerData` with a typed reader.
- `providers/fal/src/models.ts`: `FalVideoModel`.

The one genuinely awkward bit is `duration`. fal spells it `"8s"` on
Veo endpoints, `"5"` on Kling, an integer on MiniMax, `"auto"` on
Seedance, and `num_frames` on LTX-2-19b, and the endpoint id does not
predict which. Proposal: reuse the learned-correction pattern the image
adapter already uses for `image_url` versus `image_urls`. Send the
number, read the 422, retry with the string form, cache the answer per
endpoint in a `Ref`. One sub-second validation round trip per endpoint
per process, versus a lookup table that goes stale in a week.

Deliverable: MiniMax H3 and H3 Max Turbo, Dreamina Seedance, BFL FLUX 3,
Kling and LTX all reachable. One manual run against the real API.

## Phase 3: the TV station recipe

The analog of `recipes/radio-station`, and the reason the fast tier
matters.

**Why it works.** fal measured `minimax/h3-max-turbo/text-to-video` at
1.61 seconds for a 5 second clip, and `minimax/h3-max/text-to-video` at
2.82. Generation is roughly three times faster than playback, so a
prefetch fiber can stay ahead of the viewer indefinitely. That headroom
is the whole premise, exactly as the radio station depends on music
generating faster than it plays.

**Shape**, mirroring `runStation`:

```
                            [brief]
                               │
                               ▼  plan scene 0
                        { title, prompt }
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  prefetch fiber : plan scene N+1 → submit → collect → disk   │
│  main loop      : emit events + clip URLs as ServerEvent     │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼  Stream<ServerEvent>
```

- An LLM writes the next scene as structured output (`{ title, prompt }`,
  plus continuity notes) while the current clip plays.
- `VideoGenerator.submit` then `collect` inside the prefetch fiber. The
  explicit two-step is the point: the recipe shows the job surface being
  driven deliberately, and the poll interval is tuned to the model
  (sub-second for the turbo tier, not the 10 second default).
- Clips cached to disk with the `.partial` rename dance from the radio
  station, so a second pass through the loop is free.
- Driven by the `loop` primitive, with state threading `cycle`, `idx`,
  the prefetch fiber and the plans seen so far.

**The one real difference from radio.** `MusicGenerator.streamGeneration`
yields audio chunks, so the radio station tees bytes downstream as they
arrive. Video has no streaming, so a clip is a whole file. The main loop
therefore emits a `clip-ready` event carrying a URL the client fetches,
rather than a `data` variant carrying bytes. The browser client keeps
two `<video>` elements and swaps them, preloading clip N+1 while N
plays, which is the standard gapless pattern and is simpler than the
audio case.

Files: `recipes/tv-station/{README.md,recipe.ts,app.ts,run.ts,client/}`,
matching the radio station layout exactly.

Deliverable: open a tab, click Start, watch an endless AI TV channel.

## Phase 4: Google Gemini Omni

**First task, before any adapter code:** one `curl` against
`POST /v1beta/interactions` with `background: true`, `store: true` and
`model: "gemini-omni-1.1-flash"`, to confirm the server accepts it for
this model. This is the one unverified assumption in the design. If it
is rejected, the adapter documents `submit` as blocking on Omni and
everything else in this phase stands unchanged.

- `providers/google/src/GeminiOmniVideoGenerator.ts`: the Interactions
  API in `snake_case`; `background: true` plus `store: true` on submit;
  poll `GET /v1beta/interactions/{id}` with the full eight-value status
  mapping, not Google's own two-state sample loop; cancel via
  `POST /v1beta/interactions/{id}/cancel`; the `steps[]` walk for the
  `model_output` step, because `interaction.output_video` is SDK-only;
  and the file URI captured from the create response, because re-reading
  the interaction returns inline base64 instead.
- `providers/google/src/models.ts`: `GeminiOmniVideoModel`.
- Default `delivery: "inline"`, with `uri` documented as the escape
  hatch above the roughly 4 MB cap. Note that `uri` does not make the
  call return earlier; it only avoids the payload limit.

Deliverable: the direct Google path, with the same job semantics as
every other provider.

## Phase 5: direct provider packages

In priority order, each a new package at the current fixed-group
version. Each is independently shippable and none blocks the others.

1. `@effect-uai/minimax`: V2 `POST /v2/video_generation`, poll
   `GET /v2/query/video_generation/{task_id}`, `DELETE` to cancel.
   Statuses `queued` / `running` / `succeeded` / `failed` / `cancelled`.
   Content items carry first frame, last frame and references by `role`.
   Also unlocks the 2K regeneration endpoint later.
2. `@effect-uai/bytedance` (Dreamina Seedance): ModelArk
   `POST /contents/generations/tasks` and the matching retrieve, list
   and delete. Same status vocabulary as MiniMax V2. Note the region
   split (`ark.ap-southeast.bytepluses.com` versus the China host) and
   that BytePlus is not available in the United States.
3. `@effect-uai/bfl`: FLUX 3 Video. The research did not pin its wire
   shape, so this phase starts with a short spike.
4. `@effect-uai/runway`: the only provider here fal does not host.
   Modality picks the endpoint, `X-Runway-Version` header, poll
   `GET /v1/tasks/{id}`, no webhooks at all. `THROTTLED` is a task
   state rather than an HTTP error, so backoff reads the task.

## Phase 6: the remaining recipes

In the order you ranked them.

- `product-clip`: a hero still (generated or supplied) animated by an
  image-to-video model, downloaded and persisted. The smallest complete
  use of the capability.
- `storyboard-to-video`: an LLM shot list as structured output, a
  keyframe per shot from the image generator, each shot animated with
  `lastFrame` chaining for continuity. Shows fan-out over N jobs and
  per-shot retry, and is the recipe that justifies `lastFrame` being
  common.
- `ad-variants`, if it still looks worthwhile after the first two.

## Phase 7: docs and site

- Rewrite `docs/video-generation/index.md`. The async-job framing in the
  current stub survives and is correct; the provider list and the
  "rendering 38%" progress promise do not.
- `docs/video-generation/providers/{fal,google,minimax,bytedance,runway}.md`,
  each leading with that provider's result URL lifetime.
- `docs/migrations/v0-18.md`, additive.
- Webpage: capability count and card, recipe grid entries, icon map.

## Open items to resolve during implementation

1. Confirm Dreamina's `omni_reference_task_type` value list, which
   selects reference versus editing versus extension. UNVERIFIED from
   the SDK source.
2. Measure the real default lifetime of a fal result URL. The docs
   describe the override header but never state the default.
3. Confirm `background: true` is accepted for `gemini-omni-1.1-flash`.
   This is the one load-bearing unverified assumption in the design and
   is the first task of Phase 4. Everything else survives either answer.
4. Pin BFL FLUX 3 Video's wire shape before phase 5 item 3.
5. Confirm whether fal's `sync_mode` (base64 instead of a CDN URL) is
   worth exposing. It exists on the MiniMax H3 family and LTX-2-19b but
   not on Veo, Kling, Seedance or Wan, so it cannot be a portable field.
