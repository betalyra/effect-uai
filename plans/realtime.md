# Realtime speech-to-speech: design and implementation plan

Handover document for v0.13 item 4. Research and evidence live in
[research/realtime.md](./research/realtime.md) and its subreports; this
file wins on any conflict with them. Work proceeds strictly in the step
order below; each step is a separate PR that builds, typechecks and
tests green on its own.

## Principles

- **Explicit over convenient.** The library ships a low-level session
  primitive. Tool execution, playback, barge-in handling, reconnection
  and turn-taking policy are written in the recipe, out of public
  pieces. No `RealtimeAgent`, no hidden queues, no automatic tool
  runner in core.
- **Two providers or none.** OpenAI Realtime and Gemini Live must both
  fit the same types before the item ships. If Gemini does not fit,
  change the types, do not fork the recipe.
- **Current models only.** `gpt-realtime-2.1`, `gpt-realtime-2.1-mini`,
  `gemini-3.1-flash-live-preview`, `gemini-2.5-flash-native-audio-preview-12-2025`.
  No deprecated ids anywhere.
- **Don't unify what isn't unified.** Common types carry only what
  both providers do natively. VAD knobs, truncation, resumption,
  thinking, MCP, search grounding, noise reduction are provider-typed.
- **No new provider packages.** xAI and Azure are compatible endpoints
  over the OpenAI codec (base URL + auth), documented as gateways.
- **House rules.** No em-dashes anywhere. Sparse comments. `Match` over
  nested ternaries. One `Effect.tryPromise` per step. `pnpm`, `pnpx`.
  Tests exercise the real decode path; no trivial tests. WebSocket
  gotchas: `closeCodeIsError: (code) => code !== 1000 && code !== 1001 && code !== 1005`,
  and `Queue<A, Cause.Done>` + `Queue.end`, never `Queue.shutdown`.

## Core design

Files: `packages/core/src/domain/Realtime.ts` (types),
`packages/core/src/realtime/RealtimeSession.ts` (service, marker,
helpers), `packages/core/src/testing/MockRealtimeSession.ts`. Export
`Realtime` and `RealtimeSession` from `packages/core/src/index.ts` and
add `./Realtime` and `./RealtimeSession` subpaths to
`packages/core/package.json` following the existing entries.

Precedents this design follows (checked 2026-09-11):

- Scoped handle returned by a service method: `Sandbox.create` and
  `Browser.create` return handles in `Scope.Scope`, with a top-level
  helper that adds the tag to `R` ([Sandbox.ts](../packages/core/src/sandbox/Sandbox.ts),
  [Browser.ts](../packages/core/src/browser/Browser.ts)). `RealtimeSession.open`
  is the same shape.
- Tagged unions: `Data.taggedEnum` with PascalCase tags, as
  `Turn.TurnEvent` ([Turn.ts](../packages/core/src/domain/Turn.ts)).
  (`Music.ts` uses lowercase hand-rolled tags; do not copy that.)
- Capability marker: phantom `Context.Service<X, void>`, registered
  with `Layer.succeed(X, undefined)` and required in `R` by a top-level
  helper only, as `SttStreaming` in
  [Transcriber.ts](../packages/core/src/transcriber/Transcriber.ts).
- Provider layers: `make(cfg)` returns the typed service, `layer(cfg)`
  is `Layer.mergeAll` of the typed tag, the generic tag (request cast
  from Common to the typed request) and the markers, as in
  [OpenAIRealtimeTranscriber.ts](../packages/providers/openai/src/OpenAIRealtimeTranscriber.ts).
- Errors: `Data.TaggedError` classes in `AiError.ts`; `describe` is a
  `Match.discriminatorsExhaustive`, so a new variant must be added there.
- Mocks: scripted per-call lists plus a recorder `Ref`, as
  `MockTranscriber` ([MockTranscriber.ts](../packages/core/src/testing/MockTranscriber.ts)).
- `Loop` is untouched. It stays the primitive for caller-driven turns;
  a realtime session is server-driven and is its own primitive. Reuse
  `AiError.IncompleteTurn` for a dirty close mid-response.

```ts
// domain/Realtime.ts
export type RealtimeInput = Data.TaggedEnum<{
  Audio: { readonly bytes: Uint8Array } // encoded per request.inputFormat, real-time paced by the caller
  Text: { readonly text: string; readonly role?: "user" | "system" }
  ToolResult: { readonly output: ToolCallOutput }
  Interrupt: {} // cancel the in-progress response
  VideoFrame: { readonly frame: ImageSource } // gated by RealtimeVideoInput
  ActivityStart: {} // turnDetection: "manual" only
  ActivityEnd: {} // manual: also asks for a response
  PlaybackPosition: { readonly responseId: string; readonly playedMs: number } // barge-in bookkeeping; no-op where the wire has no truncate
}>

export type RealtimeEvent = Data.TaggedEnum<{
  ResponseStarted: { readonly responseId: string }
  AudioDelta: { readonly responseId: string; readonly bytes: Uint8Array } // encoded per request.outputFormat
  OutputTranscriptDelta: { readonly responseId: string; readonly text: string }
  InputTranscript: { readonly text: string; readonly final: boolean }
  SpeechStarted: {} // sparse: OpenAI emits it, Gemini does not
  SpeechStopped: {}
  ToolCall: { readonly responseId: string; readonly call: ToolCall } // Items.ToolCall, arguments as JSON string
  ToolCallCancelled: { readonly callIds: ReadonlyArray<string> }
  Interrupted: { readonly responseId: string } // stop and flush playback now
  ResponseDone: {
    readonly responseId: string
    readonly reason: "complete" | "interrupted" | "cancelled" | "error"
    readonly usage?: Usage
  }
  ResumptionHandle: { readonly handle: string } // Gemini only; caller may pass it as request.resume
  SessionEnding: { readonly timeLeft?: Duration.Duration }
  Error: { readonly code?: string; readonly message: string } // non-fatal; fatal errors fail the stream
}>

export type CommonSessionRequest = {
  readonly model: string
  readonly instructions?: string
  readonly voiceId?: string
  readonly tools?: ReadonlyArray<ToolDescriptor> // Tool.descriptorsOf(toolkit)
  readonly inputFormat: AudioFormat
  readonly outputFormat: AudioFormat
  readonly turnDetection?: "server" | "manual" // default "server"
  readonly transcribeInput?: boolean // default true
  readonly history?: ReadonlyArray<HistoryItem> // text-only seed
  readonly resume?: string // Gemini handle; Unsupported elsewhere
}
```

```ts
// realtime/RealtimeSession.ts
export type RealtimeSessionHandle = {
  readonly send: (input: RealtimeInput) => Effect.Effect<void, AiError.AiError>
  readonly events: Stream.Stream<RealtimeEvent, AiError.AiError>
}
export type RealtimeSessionService = {
  readonly open: (
    request: CommonSessionRequest,
  ) => Effect.Effect<RealtimeSessionHandle, AiError.AiError, Scope.Scope>
}
export class RealtimeSession extends Context.Service<RealtimeSession, RealtimeSessionService>()(
  "@betalyra/effect-uai/RealtimeSession",
) {}
export class RealtimeVideoInput extends Context.Service<RealtimeVideoInput, void>()(
  "@betalyra/effect-uai/capability/RealtimeVideoInput",
) {}

export const open = (request) => Effect.flatMap(RealtimeSession, (s) => s.open(request))
```

Semantics every adapter must honour (write them as tests):

1. `open` connects, completes the provider handshake (`session.updated`
   / `setupComplete`) and only then succeeds. Closing the `Scope`
   closes the socket. `send` after close fails with `AiError.Unavailable`.
2. `events` ends when the socket closes cleanly. A close **never**
   synthesizes `ResponseDone`; an in-flight response ends the stream
   with `AiError.IncompleteTurn`. Transport failures on open map to
   `AuthFailed` / `Unavailable` / `Timeout`.
3. Every `AudioDelta` and `OutputTranscriptDelta` is bracketed by
   `ResponseStarted` and `ResponseDone` with the same `responseId`.
4. `Interrupted` is emitted before the corresponding `ResponseDone
{ reason: "interrupted" }`. Pending tool calls of that response are
   reported with `ToolCallCancelled`.
5. `ToolResult` for an unknown `call_id` fails with `InvalidRequest`.
   The adapter resumes generation after the result (OpenAI:
   `function_call_output` item + `response.create`; Gemini:
   `toolResponse`), the caller does not.
6. `VideoFrame` on a Layer without `RealtimeVideoInput` fails with
   `Unsupported` at runtime; the type-level guard is a marker check on
   a top-level helper `sendVideoFrame` that requires the marker in `R`.
7. `Audio` is not paced or buffered by the adapter; the caller sends at
   real time. Frames are forwarded as they arrive.
8. `ActivityStart` / `ActivityEnd` on a `"server"` session and
   `PlaybackPosition` on a provider without truncation are dropped
   with `Capabilities.warnDropped`.
9. `Text` with role `system` maps to a system item (OpenAI) or is
   rejected `Unsupported` (Gemini 3.1, which has no mid-session system
   updates on the Gemini API).

Recipe-facing helpers in core, all optional and built from the handle:
`RealtimeSession.audioDeltas(events)`, `RealtimeSession.toolCalls(events)`
(filters), and `RealtimeSession.resumable(request)` in step 9, later.

## Provider mapping (summary; wire detail in the research subreports)

| Concept         | OpenAI ([wire](./research/realtime/openai-realtime-wire.md))                                                                                                                                                       | Gemini ([wire](./research/realtime/gemini-live-wire.md))                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect         | `wss://{host}/v1/realtime?model=`; `Authorization: Bearer` via `ws` header constructor (existing pattern); wait for `session.created`, send `session.update { type: "realtime", ... }`, wait for `session.updated` | `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=`; global constructor (no `ws` dep); send `setup`, wait for `setupComplete` |
| Audio in        | `input_audio_buffer.append` base64; `audio.input.format { type: "audio/pcm", rate: 24000 }` or pcmu / pcma                                                                                                         | `realtimeInput.audio { data, mimeType: "audio/pcm;rate=16000" }`                                                                                                                                      |
| Audio out       | `response.output_audio.delta` (24 kHz pcm16)                                                                                                                                                                       | `serverContent.modelTurn.parts[].inlineData` (24 kHz pcm16)                                                                                                                                           |
| Text            | `conversation.item.create` message + `response.create`                                                                                                                                                             | `realtimeInput.text`                                                                                                                                                                                  |
| Tools           | `session.tools[{ type: "function", ... }]`; `response.function_call_arguments.done`; `function_call_output` + `response.create`                                                                                    | `setup.tools[{ functionDeclarations }]`; `toolCall.functionCalls[]` (args object, stringify); `toolResponse.functionResponses[{ id, name, response }]` (keep `call_id` to `name` map)                 |
| Interrupt       | `response.cancel`                                                                                                                                                                                                  | `activityStart` in manual mode; otherwise no wire op, `warnDropped`                                                                                                                                   |
| Barge-in        | `input_audio_buffer.speech_started` then `response.done` cancelled `turn_detected`; on `PlaybackPosition` send `conversation.item.truncate { item_id, audio_end_ms }`                                              | `serverContent.interrupted: true` then `turnComplete`; `toolCallCancellation.ids`                                                                                                                     |
| Manual turns    | `turn_detection: null`; `ActivityEnd` = `input_audio_buffer.commit` + `response.create`                                                                                                                            | `automaticActivityDetection.disabled: true`; `activityStart` / `activityEnd`                                                                                                                          |
| Transcripts     | `audio.input.transcription.model: "gpt-live-transcribe"`; `conversation.item.input_audio_transcription.delta/.completed`; `response.output_audio_transcript.delta`                                                 | `inputAudioTranscription: {}`, `outputAudioTranscription: {}`; `serverContent.inputTranscription/.outputTranscription`                                                                                |
| Response bounds | `response.created` / `response.done` (`status`, `usage`)                                                                                                                                                           | first part of a turn / `turnComplete` (+ `usageMetadata`); `generationComplete` ignored                                                                                                               |
| Lifetime        | `session.created.session.expires_at` (60 min): emit `SessionEnding` 60 s before                                                                                                                                    | `goAway.timeLeft` -> `SessionEnding`; `sessionResumptionUpdate.newHandle` when `resumable` -> `ResumptionHandle`; `request.resume` -> `sessionResumption.handle`                                      |
| Video           | Unsupported (no marker)                                                                                                                                                                                            | `realtimeInput.video { data, mimeType: "image/jpeg" }`; registers `RealtimeVideoInput`                                                                                                                |
| Provider-typed  | `turnDetection` object (`server_vad` / `semantic_vad` knobs), `noiseReduction`, `truncation`, `reasoning`, `maxOutputTokens`, `speed`, MCP tools, `outputModalities: ["text"]`                                     | `automaticActivityDetection` knobs, `thinkingConfig`, `mediaResolution`, `contextWindowCompression`, `googleSearch`, `proactivity`, `enableAffectiveDialog`, `turnCoverage`                           |

## Steps

### Step 1: fix the OpenAI realtime transcriber (independent, do first)

Goal: the shipped `OpenAIRealtimeTranscriber` sends the
`OpenAI-Beta: realtime=v1` header, which OpenAI shut down 2026-05-12,
and defaults to STT models on the 2027-02-26 shutdown list.

- `packages/providers/openai/src/realtimeStt.ts`: remove the beta
  header; use the GA session shape (`session.update` with `type:
"transcription"`, `audio.input.format`, `audio.input.transcription`,
  `audio.input.turn_detection`); check whether `?intent=transcription`
  is still accepted or must be dropped (UNVERIFIED in research).
- `packages/providers/openai/src/models.ts`: transcription model union
  gains `gpt-live-transcribe`, `gpt-transcribe`, `gpt-realtime-whisper`;
  keep the deprecated ids in the union with a comment and shutdown date.
- Update recipe defaults that use `gpt-4o-transcribe` in
  `recipes/_shared/model.ts` and `recipes/streaming-transcription`.
- Live check with `OPENAI_API_KEY` via the streaming-transcription
  recipe. Add a frame-mapper test through the real `Schema` decode for
  the GA event names.
- Done when: the recipe transcribes live audio again; changeset with a
  migration note.

### Step 2: core capability

Goal: types, tag, marker, mock. No adapter yet.

- Add the types above in `domain/Realtime.ts` and the service in
  `realtime/RealtimeSession.ts`, `Data.taggedEnum` style like
  `Turn.TurnEvent`.
- `AiError`: add `SessionExpired { provider, raw? }` (extend `describe`).
- `testing/MockRealtimeSession.ts`: scripted layer. Constructor takes
  a script `(input: RealtimeInput) => ReadonlyArray<RealtimeEvent>`
  plus an initial event list; records every `send` in a `Ref` for
  assertions; `layer` registers `RealtimeVideoInput`, `layerAudioOnly`
  does not.
- Tests (`RealtimeSession.test.ts`): `expectTypeOf` that
  `sendVideoFrame` fails to provide against `layerAudioOnly`; the
  mock round trip (send audio, receive scripted events, close scope
  ends `events`).
- `docs/realtime/index.md`: replace "Coming soon" with the type
  sketch and the semantics list, marked "not yet shipped" until step 4.
- Done when: core builds, typecheck and tests green, exports added.

### Step 3: OpenAI adapter (first provider; simpler: GA, no reconnect, `ws` already present)

Goal: `packages/providers/openai/src/realtimeSession.ts` (wire) and
`OpenAIRealtimeSession.ts` (layer), mirroring the `realtimeStt.ts` /
`OpenAIRealtimeTranscriber.ts` split: a typed `OpenAIRealtimeSession`
tag whose `open` takes `OpenAIRealtimeRequest`, plus `layer(cfg)` that
`Layer.mergeAll`s the typed tag and the generic `RealtimeSession` tag.
No marker for OpenAI (no video).

- Extract a small shared helper first, in
  `packages/core/src/streaming/WebSocketSession.ts`: connect with the
  clean-close predicate and `openTimeout`, `SocketError` to `AiError`
  mapping, reader fiber into `Queue<Frame, Cause.Done>` with
  `Queue.end`, writer, and a `decode` pipeline
  (`JSONL.parseSafe` -> `Schema.decodeUnknownEffect` -> mapper, unknown
  frames dropped). Only what the new adapter needs; the seven existing
  adapters are **not** migrated in this step.
- Config `{ apiKey, baseUrl?, region?, headers? }`; `baseUrl` +
  `headers` are what make xAI and Azure reachable later. No xAI or
  Azure code.
- `OpenAIRealtimeRequest extends CommonSessionRequest` narrows `model`
  to `"gpt-realtime-2.1" | "gpt-realtime-2.1-mini" | (string & {})`
  and adds the provider-typed fields from the table.
- Handshake: wait for `session.created`, send `session.update`, wait
  for `session.updated`, then resolve `open`. Record `expires_at` and
  fork a timer for `SessionEnding`.
- Response tracking: `response.created` -> `ResponseStarted`;
  `response.done` -> `ResponseDone` with `reason` from `status` and
  `status_details.reason`; `speech_started` -> `SpeechStarted`, and if
  a response is in flight also `Interrupted` (before the
  `response.done` cancelled arrives). Keep the current assistant
  `item_id` so `PlaybackPosition` can send `conversation.item.truncate`.
- Tools: `response.function_call_arguments.done` -> `ToolCall`;
  `ToolResult` -> `conversation.item.create { function_call_output }`
  then `response.create`.
- Tests: frame-mapper tests for every event in the table through the
  real `Schema` decode; lifecycle test with an in-memory fake
  `WebSocket` provided via `Socket.WebSocketConstructor` (scripted
  frames: handshake, one audio response, barge-in, tool call round
  trip, dirty close -> `IncompleteTurn`). No live tests.
- Exports: `package.json` subpath, `index.ts` namespace line, models
  union in `models.ts`.
- Done when: a headless script (`experiments/`, not a recipe) can send
  a WAV, hear audio back and complete a tool call against the live API.

### Step 4: basic recipe `realtime-voice-agent` (OpenAI only at this step)

Goal: the base recipe, mirroring `recipes/voice-loop` file for file:
`app.ts`, `recipe.ts`, `run.ts`, `client/`, `README.md`, `recipe.test.ts`.

- `recipe.ts` is the explicit wiring: open the session, fork the mic
  forwarder, consume `events` with `Match`, run `Toolkit.run` on
  `ToolCall` in a forked fiber and `send` the `ToolResult`, interrupt
  that fiber on `ToolCallCancelled`, send `PlaybackPosition` on
  `Interrupted` using the server-side played-ms estimate, emit
  `StatusEvent`s to the browser. One or two small demo tools (time,
  weather stub) plus `--mcp` to reuse the `mcp-tools` toolkit if cheap.
- `app.ts`: `--provider openai` only for now, `/config` returns
  `micSampleRate: 24000`, `playbackSampleRate: 24000`; the WebSocket
  bridge from voice-loop.
- `client/`: copy voice-loop's client; playback worklet warmup derived
  from `sampleRate` (currently hard-coded for 48 kHz); worklet reports
  played samples back over the socket (for `PlaybackPosition`);
  `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })`;
  a text input box that sends `Text`; no stop-word watcher.
- `recipes/_shared/model.ts`: `realtimeSessionLayer` picker with an
  `openai` entry.
- `recipe.test.ts` against `MockRealtimeSession`: one utterance
  produces audio, a tool call is answered, an interruption flushes.
- README written usage-POV (what you hear, what to try), like
  voice-loop's.
- Done when: `bun recipes/realtime-voice-agent/run.ts` talks, barges
  in, and calls a tool from the browser on all three runtimes.

### Step 5: Gemini adapter, then `--provider google` in the recipe

Goal: `packages/providers/google/src/realtimeSession.ts` and
`GeminiLiveSession.ts`. This step validates the abstraction; expect to
touch core types if Gemini does not fit, and say so in the PR.

- Auth on the URL (`?key=`) with `Socket.layerWebSocketConstructorGlobal`,
  no `ws` dependency in the google package.
- Handshake: `setup` with `model: "models/..."`,
  `generationConfig.responseModalities: ["AUDIO"]`, `speechConfig`,
  `systemInstruction`, `tools`, `inputAudioTranscription`,
  `outputAudioTranscription`, `sessionResumption: {}` always, plus
  provider-typed fields; wait for `setupComplete`. Export
  `toolDescriptorsToTools` from `google/src/codec.ts` for the
  `functionDeclarations` rendering.
- Response tracking: Gemini has no response id; mint one per turn on
  the first `modelTurn` part after a `turnComplete`. `interrupted` ->
  `Interrupted` + `ResponseDone { reason: "interrupted" }`;
  `turnComplete` -> `ResponseDone { reason: "complete" }` with the
  latest `usageMetadata`. 3.1 packs several parts per event: iterate.
- Tools: `toolCall.functionCalls[]` -> one `ToolCall` each with
  `JSON.stringify(args)`; keep `id -> name`; `ToolResult` ->
  `toolResponse`. `toolCallCancellation.ids` -> `ToolCallCancelled`.
- Lifetime: `goAway` -> `SessionEnding`; `sessionResumptionUpdate`
  with `resumable: true` -> `ResumptionHandle`; `request.resume` ->
  `sessionResumption.handle`. No automatic reconnect in the adapter.
- Typed `GeminiLiveSession` tag plus the generic tag via `layer(cfg)`,
  same split as step 3.
- Registers `RealtimeVideoInput`; `VideoFrame` -> `realtimeInput.video`
  with `image/jpeg`.
- Models union `GeminiLiveModel` in `google/src/models.ts`.
- Tests as in step 3 (mapper tests through the real decode, fake
  socket lifecycle including `goAway` and `interrupted`).
- Recipe: add the `google` entry (`micSampleRate: 16000`), README
  section on the differences (no `SpeechStarted`, ten-minute socket,
  audio-only output).
- Done when: the same recipe runs on `--provider google` with tools
  and barge-in; both providers share `recipe.ts` unchanged.

### Step 6: recipe `voice-tool-approval`

Goal: a sensitive tool call gated by a human while the call stays live.
Mirrors `tool-call-approval` (the `Approval.fromQueue` gate) on top of
step 4's client with Approve / Deny buttons.

- Spike first (in `experiments/`): on Gemini 3.1, while a function
  call is pending, is user audio still processed and can `Text` be
  sent? Research says the model stays silent until `toolResponse`;
  the rest is undocumented. If the spike shows the call blocks the
  session, the recipe documents Gemini as "silent while waiting" and
  uses OpenAI for the spoken placeholder.
- On OpenAI: on `ToolCall` that needs approval, `send Text { role:
"system", text: "Tell the user you are waiting for approval" }` so
  the model speaks a placeholder, then `send ToolResult` when the
  verdict arrives.
- Done when: a denied call yields a spoken refusal and an approved
  call completes, with the conversation still responsive in between.

### Step 7: recipe `camera-assistant` (Gemini only)

Goal: frames as one more input on the same session.

- Client: `<video>` preview, canvas snapshot at 1 fps as JPEG (768
  px), sent only while the user is speaking (3.1 bills all frames);
  `--source camera|screen` switches `getUserMedia` for
  `getDisplayMedia`.
- Request: `contextWindowCompression` on (audio + video caps at 2 min
  otherwise), `mediaResolution: MEDIA_RESOLUTION_LOW`.
- `--frames dir/` headless fallback paces JPEGs from disk.
- Done when: "what am I looking at" works from the browser; the
  OpenAI Layer is a compile error for this recipe via the marker.

### Step 8: docs and site

- `docs/realtime/index.md` (usage-POV: opening a session, the event
  loop, tools, barge-in, lifetime), provider pages for OpenAI and
  Gemini, a gateway page listing xAI (`wss://api.x.ai/v1/realtime`,
  ephemeral subprotocol), Azure OpenAI Realtime and Azure Voice Live
  as compatible endpoints via `baseUrl` + `headers`, each with the
  known deviations from the survey.
- `webpage/astro.config.mjs`: remove `realtime` from `stubPagePattern`
  and the llms exclude, replace the "Coming soon" sidebar entry with a
  Realtime block listing the recipes (model on the Speech block).
- `Hero.astro` capability count, `CapabilitiesSection.tsx` card,
  `PageTitle.astro` icon, `RecipesSection.tsx` icons.
- Changesets for core, openai, google; migration entry for step 1.

### Step 9: optional follow-ups (separate PRs, after the item ships)

- `call-supervisor` recipe (`Stream.share` on `events` plus a text
  `LanguageModel` classifier).
- `RealtimeSession.resumable(request)` helper that reopens a Gemini
  session on `SessionEnding` with the last `ResumptionHandle`.
- `--input file.wav` headless mode on `realtime-voice-agent` (a paced
  WAV as the user; useful for tests and demos).
- Migrate the seven existing WebSocket adapters onto
  `WebSocketSession.ts`.

## Postponed (not in v0.13)

Amazon Nova 2 Sonic (`@effect-uai/bedrock`, HTTP/2 event stream), Hume
EVI, the OpenAI preview dialect for Qwen / StepFun, OpenAI WebRTC and
the server sideband socket, ephemeral-token minting helpers, OpenAI
image items inside a session, translation session types
(`gpt-realtime-translate`, `gemini-3.5-live-translate-preview`),
`plans/websocket.md`'s text-only `LanguageModelSession`.

## Open questions to settle during the build

- Step 3: is `?intent=transcription` still needed for transcription
  sessions on GA, and what does the server send on session expiry
  (code, close frame)? Verify live and record in the wire report.
- Step 5: the `v1beta` vs `v1alpha` path for ephemeral tokens is only
  relevant if step 9 adds token helpers; ignore until then.
- Step 6: Gemini 3.1 pending-call behaviour (the spike).
- Step 4: whether the played-ms estimate from the server-side pacing is
  good enough for `conversation.item.truncate`, or the worklet's
  reported position is needed. Try the estimate first.
