# Research: realtime speech-to-speech (v0.13 item 4, "live audio")

Provider survey, wire research, prior-art review, recipe selection and
repo audit for [v0-13.md](../v0-13.md) section 4 and the
[docs/realtime](../../docs/realtime/index.md) stub. Primary sources
(vendor docs, API references, pricing pages, SDK source) plus the
Artificial Analysis speech-to-speech index and Big Bench Audio,
2026-09-11. Unconfirmed claims are marked UNVERIFIED in the subreports.
Full subagent reports are in [realtime/](./realtime/):

- [openai-realtime-wire.md](./realtime/openai-realtime-wire.md)
- [gemini-live-wire.md](./realtime/gemini-live-wire.md)
- [provider-survey.md](./realtime/provider-survey.md)
- [sdk-prior-art.md](./realtime/sdk-prior-art.md)
- [recipe-use-cases.md](./realtime/recipe-use-cases.md)
- [repo-audit.md](./realtime/repo-audit.md)

## Verdict up front

Launch providers stay **OpenAI Realtime** and **Gemini Live**, by
extending the two existing packages, exactly as v0.13 planned. Both are
native audio-to-audio models over a WebSocket, both have server-side
VAD, barge-in, client-executed function tools, text injection and
transcripts, and both are what every framework (LiveKit, Pipecat,
Vercel AI SDK 7, Mastra) ships first. No new provider package is
needed for launch.

Four things in the v0.13 plan and the docs stub are stale:

- `gpt-realtime` and `gpt-realtime-mini` (the 2025 GA ids) are already
  deprecated (announced 2026-07-20, shutdown 2027-01-20). Target
  `gpt-realtime-2.1` and `gpt-realtime-2.1-mini` (GA 2026-07-06).
- The `OpenAI-Beta: realtime=v1` header was shut down on 2026-05-12
  and now fails the upgrade. The shipped OpenAI realtime STT adapter
  still sends it ([realtimeStt.ts:174](../../packages/providers/openai/src/realtimeStt.ts#L174)),
  so `OpenAIRealtimeTranscriber` is very likely broken today. Needs a
  live check and a fix independent of this capability.
- Gemini's half-cascade models shut down 2025-12-09. Every current
  Live model is native audio and outputs **audio only**; text comes
  from `outputAudioTranscription`. The stub's "audio + text out" is
  wrong for `gemini-3.1-flash-live-preview`.
- OpenAI has **no video input** on Realtime (still images only, as
  conversation items). "Camera in" is a Gemini-only feature, so it
  needs a capability marker, not a common promise.

One new thing to keep straight: on 2026-09-10 OpenAI shipped
`gpt-live-1`, a separate full-duplex product on `/v1/live/sessions`
with its own event vocabulary and per-minute billing. It is not a
Realtime API model and is out of scope here; several OpenAI doc pages
currently render GPT-Live content under Realtime URLs, so cross-check
event names against the SDK types.

## The two launch providers

|                | OpenAI Realtime                                                                                                                                                                                                                   | Gemini Live                                                                                                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models         | `gpt-realtime-2.1`, `gpt-realtime-2.1-mini` (GA, 128k ctx, image input, `reasoning.effort`)                                                                                                                                       | `gemini-3.1-flash-live-preview` (recommended), `gemini-2.5-flash-native-audio-preview-12-2025` (Preview; the whole Live API is Preview)                                                                               |
| Price          | 2.1: audio $32 in / $64 out per 1M tokens (about $0.019/min in, $0.077/min out); mini: $10 / $20                                                                                                                                  | 3.1: audio $3 in / $12 out per 1M (about $0.005/min in, $0.018/min out); billed per turn over the whole context                                                                                                       |
| Transport      | WebSocket `wss://api.openai.com/v1/realtime?model=`, `Authorization: Bearer`; WebRTC (`POST /v1/realtime/calls`, ephemeral `ek_` keys) for browsers; SIP inbound                                                                  | WebSocket `.../ws/...GenerativeService.BidiGenerateContent?key=` (API key on the URL); ephemeral tokens via `POST /v1beta/auth_tokens` on the `BidiGenerateContentConstrained` RPC                                    |
| Audio          | pcm16 mono 24 kHz in and out (g711 8 kHz for telephony); base64 in JSON                                                                                                                                                           | pcm16 16 kHz in (`audio/pcm;rate=16000`), 24 kHz out; base64 in JSON                                                                                                                                                  |
| Turn detection | `server_vad` (threshold, padding, silence, `idle_timeout_ms`, `create_response`, `interrupt_response`), `semantic_vad` (`eagerness`), or `null` = manual (append, commit, `response.create`)                                      | `automaticActivityDetection` (start/end sensitivity, `prefixPaddingMs`, `silenceDurationMs`), `activityHandling`, or `disabled` = manual (`activityStart` / `activityEnd`)                                            |
| Barge-in       | Server cancels the response (`response.done` status `cancelled`, reason `turn_detected`). On WebSocket the client must stop playback and send `conversation.item.truncate` with `audio_end_ms`                                    | `serverContent.interrupted: true`, then `turnComplete`; client flushes playback; pending calls arrive in `toolCallCancellation.ids`. No truncate call                                                                 |
| Tools          | Function tools at session or response level, `function_call_output` item + `response.create`; hosted MCP tools with approval items; `parallel_tool_calls` on 2.x                                                                  | `functionDeclarations` in `setup.tools` (immutable per connection), `toolCall` mid-stream, `toolResponse` on the same socket; 3.1 is synchronous only, 2.5 has `NON_BLOCKING` + `scheduling`; Google Search grounding |
| Text in        | `conversation.item.create` (user or system message) + `response.create`                                                                                                                                                           | `realtimeInput.text` (3.1); `clientContent` only seeds history on 3.1                                                                                                                                                 |
| Transcripts    | Input: separate ASR run (`gpt-live-transcribe` recommended; `whisper-1` and `gpt-4o-transcribe` shut down 2027-02-26), delta + completed, often lands after the response starts. Output: `response.output_audio_transcript.delta` | `inputAudioTranscription` / `outputAudioTranscription` in setup; input transcripts unordered relative to other frames; 3.1 packs several parts per event                                                              |
| Session limits | 60 min hard (`session.expires_at`), no resumption, replay history into a new session; `truncation` (`auto`, `retention_ratio`) for context                                                                                        | About 10 min per WebSocket with `goAway.timeLeft`; 15 min audio or 2 min audio+video without `contextWindowCompression`; `sessionResumption` handles valid 2 h, everything but `model` may change on resume           |
| Video          | None                                                                                                                                                                                                                              | JPEG frames at <= 1 fps via `realtimeInput.video`; 3.1 bills all frames by default (`turnCoverage`)                                                                                                                   |
| Mutability     | `session.update` at any time except `model` (never) and `voice` (locked after first audio)                                                                                                                                        | Config immutable per connection; reconnect with the handle to change tools or instructions                                                                                                                            |
| Extras         | Out-of-band `response.create` with `conversation: "none"`, `noise_reduction`, `prompt` references, `tracing`, image items                                                                                                         | `thinkingLevel` (3.1), `mediaResolution`, `proactiveAudio` and `enableAffectiveDialog` (2.5 only), search grounding as executable code parts                                                                          |

Both providers are fully usable over a raw WebSocket with Effect's
`Socket`, no vendor SDK required. Wire details:
[openai-realtime-wire.md](./realtime/openai-realtime-wire.md),
[gemini-live-wire.md](./realtime/gemini-live-wire.md).

## Other providers

The survey covered 30 vendors. Native speech-to-speech model APIs with
inline configuration (prompt, tools, voice passed at connect time):

| Provider                                                                       | What                                                                                                                                | Protocol                                                                                                                                                        | Verdict                                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| xAI Grok Voice Agent API                                                       | `grok-voice-latest` / `grok-voice-think-fast-2.0`, $0.08/min, #1 on Big Bench Audio and top of the Artificial Analysis speech index | OpenAI GA dialect, near verbatim, plus extensions (`force_message`, cumulative `input_audio_transcription.updated`, `resumption`); `wss://api.x.ai/v1/realtime` | **Compatible endpoint**, no package: the OpenAI Realtime codec takes a base URL and auth adapter, same move as xAI over the Images codec. Document as a gateway                         |
| Azure OpenAI Realtime                                                          | gpt-realtime family on `/openai/v1/realtime`                                                                                        | OpenAI GA, verbatim; `api-key` or Entra bearer                                                                                                                  | Compatible endpoint, gateway docs                                                                                                                                                       |
| Azure Voice Live                                                               | gpt-realtime family plus Azure's own `azure-realtime` and cascaded GPT-5.x                                                          | OpenAI events plus additive `azure_*` session fields and viseme / timestamp / avatar events                                                                     | Compatible endpoint if the codec keeps an open extension slot on `session.update`; extras stay untyped. Docs candidate                                                                  |
| Amazon Nova 2 Sonic                                                            | `amazon.nova-2-sonic-v1:0`, the only hyperscaler-native alternative                                                                 | Proprietary JSON events over an HTTP/2 event stream, SigV4, 8 min per connection                                                                                | Real, but a different transport and a new `@effect-uai/bedrock` package. **Defer**: v0.13 lists Bedrock as not in scope (#134) and the abstraction should settle on two providers first |
| Hume EVI                                                                       | EVI 3 / EVI 4 mini, expressive, emotion scores, $0.04 to $0.07/min                                                                  | Proprietary, about 20 message types, inline `session_settings`                                                                                                  | Second wave, new package                                                                                                                                                                |
| Qwen-Omni-Realtime, StepFun                                                    | Cheap, strong leaderboard scores, Asia regions                                                                                      | OpenAI **preview** dialect (`response.audio.delta`, `modalities`)                                                                                               | Second wave, only if the codec grows a `preview` dialect flag; needs Singapore or China accounts                                                                                        |
| Inworld Realtime                                                               | Cascade (STT + routed LLM + TTS) behind an OpenAI-dialect socket                                                                    | OpenAI GA dialect, extended                                                                                                                                     | On demand via the compatible endpoint; existing package                                                                                                                                 |
| Deepgram Voice Agent, AssemblyAI, Ultravox, Speechmatics Flow                  | Cascades branded as agents                                                                                                          | Proprietary                                                                                                                                                     | Skip                                                                                                                                                                                    |
| ElevenLabs Agents, Cartesia Line, Retell, Vapi                                 | Agent platforms: prompt, tools and voice are a server-side resource (`agent_id`, `template_id`)                                     | Proprietary                                                                                                                                                     | Skip: resource management, out of scope                                                                                                                                                 |
| Mistral, Anthropic, Meta, MiniMax, Fish, Groq, Fireworks, Together, OpenRouter | No speech-to-speech model API (Mistral documents it as a pipeline you build yourself; Anthropic has none)                           |                                                                                                                                                                 | Nothing to add                                                                                                                                                                          |
| Kyutai Moshi / Unmute, NVIDIA PersonaPlex, Sesame                              | Open weights or early access, no hosted endpoint                                                                                    |                                                                                                                                                                 | Revisit if hosted                                                                                                                                                                       |

**Is there a standard?** Yes, de facto: the OpenAI Realtime event
family, in two dialects. GA dialect (`response.output_audio.delta`,
`output_modalities`, `audio.input.*`): OpenAI, Azure OpenAI, Azure
Voice Live, xAI, Inworld. Preview dialect (`response.audio.delta`,
`modalities`): Qwen, StepFun, vLLM-omni. Not compatible: Gemini Live,
Nova Sonic, ElevenLabs, Hume, Deepgram, Ultravox. LiveKit's plugin
split mirrors this exactly (one OpenAI plugin with thin xAI and Azure
wrappers; bespoke plugins for Gemini, Nova, Ultravox).

Consequence: the OpenAI Realtime codec is parameterised by base URL
plus an auth adapter (bearer header, `api-key`, xAI's ephemeral
subprotocol), keeps every request field optional, tolerates unknown
server events, and keeps an open extension slot on `session.update`.
That covers five vendors with one codec. Full report:
[provider-survey.md](./realtime/provider-survey.md).

## What prior art agrees on

LiveKit Agents, Google ADK, the OpenAI Agents SDK, Pipecat and Vercel
AI SDK 7 were compared concept by concept
([sdk-prior-art.md](./realtime/sdk-prior-art.md), section 8). ADK's
`LiveRequestQueue` and LiveKit's `RealtimeSession` converged
independently on the same input set, which is strong evidence for the
shape the docs stub already promised.

Common on every provider and every SDK:

- Inputs: audio frame, text message, tool result, interrupt.
- Outputs: audio delta, output transcript delta, input transcript
  (partial / final honesty per adapter), response started / done with
  usage, tool call, tool call cancelled, interrupted, error.

Not unifiable, per LiveKit's own capability flags
(`message_truncation`, `mutable_tools`, `mutable_instructions`,
`auto_tool_reply_generation`, `per_response_tool_choice`):

- Turn-detection knobs: three incompatible shapes (OpenAI
  `server_vad` / `semantic_vad`, Gemini sensitivities, Nova
  `HIGH / MEDIUM / LOW`). Only "server-owned" vs "manual" is common.
- Mid-session config changes: OpenAI `session.update` any time;
  Gemini 3.1 needs a reconnect with a resumption handle.
- Playback truncation: only OpenAI has `conversation.item.truncate`.
  Every SDK keeps played-ms bookkeeping outside the provider adapter:
  OpenAI Agents JS approximates with wall clock since the first delta,
  Pipecat takes `min(elapsed, bytes-derived)`, LiveKit reads the real
  playout position from the audio sink.
- Session lifetime: 8 / 10 / 30 / 60 / 120 minutes depending on
  vendor. Reconnect-with-context is an adapter concern.
- Video input, out-of-band responses, hosted MCP, proactive audio,
  affective dialog, reasoning effort, noise reduction: one provider
  each.

Backpressure: no SDK applies any to audio input (unbounded or
fire-and-forget); providers require real-time pacing. Vercel AI SDK 7's
vocabulary is visibly OpenAI-shaped (`conversation-item-truncate`,
`input-audio-commit`) with no home for Gemini's `interrupted`, which
is the trap to avoid.

## Capability design notes

Everything here is input to the design doc, which wins on conflict.

**Own primitive, not a `Loop` body.** `Loop` is pull-based with
caller-owned iteration boundaries and fails `IncompleteTurn` without a
terminal event ([Loop.ts](../../packages/core/src/loop/Loop.ts)). A
duplex session has server-owned turns, interrupted responses that
never complete, and tool responses that go back mid-turn. `RealtimeSession`
is its own service; a recipe may layer `Loop` on top, never underneath.
Its event union is a separate `RealtimeEvent`, not an extension of
`TurnEvent`. `plans/websocket.md` (text-only `LanguageModelSession`,
never implemented) stays a separate plan; the shared WebSocket helper
below serves both.

**Shape.** Decided 2026-09-11: an explicit session handle,
`RealtimeSession.open(request): Effect<{ send, events }, AiError, Scope>`.
Audio is the only continuous input, but tool results are produced
downstream of `events` and must travel back in, and a feedback edge
in a pull-based pipeline needs a buffer somewhere. The transformer
shape (`Stream<RealtimeInput>` to `Stream<RealtimeEvent>`, as
[MusicInteractiveSession](../../packages/core/src/music-generator/MusicGenerator.ts)
declares) would have to hide that queue in a helper, which is the
opposite of the library's goal. With the handle, the recipe forks the
mic forwarder, consumes `events` with `Match`, runs `Toolkit.run` on
`ToolCall` in its own fiber and calls `send` with the result; every
fiber and every send is on the page. Fan-out is ordinary
`Stream.share` on `events`. Final types and semantics:
[plans/realtime.md](../realtime.md).

**Common request:** `model`, `instructions`, `voiceId`, `tools`
(descriptors from a `Toolkit`), `inputFormat` / `outputFormat`
(`AudioFormat`), `turnDetection: "server" | "manual"`, `transcribeInput:
boolean`, an optional text-only history seed. Nothing else is shared.

**Common `RealtimeInput`:** `AudioFrame`, `Text`, `ToolResult`,
`Interrupt`, `VideoFrame` (marker-gated), plus `ActivityStart` /
`ActivityEnd` for manual mode (OpenAI maps `ActivityEnd` to commit +
`response.create`, Gemini to its activity markers). An optional
`PlaybackPosition { ms }` input lets a caller with a real player clock
make OpenAI's truncate exact; without it the OpenAI adapter uses the
wall-clock estimate every SDK uses.

**Common `RealtimeEvent`:** `AudioDelta { bytes, responseId }`,
`OutputTranscriptDelta`, `InputTranscript { text, final }`,
`SpeechStarted` (OpenAI only, documented as sparse), `ResponseStarted`,
`ResponseDone { usage, reason }`, `ToolCall` (reuses `Items.ToolCall`),
`ToolCallCancelled`, `Interrupted`, `UsageUpdate`, `SessionEnding
{ timeLeft? }`, non-fatal `Error`. A socket close must never
synthesize a `ResponseDone` (the `onHalt` rule).

**Provider-typed:** VAD knobs, `noise_reduction`, `truncation`,
`reasoning`, MCP tools, out-of-band responses, image items (OpenAI);
sensitivities, `thinkingLevel`, `mediaResolution`, `contextWindowCompression`,
`sessionResumption`, search grounding, `proactivity`, `enableAffectiveDialog`
(Gemini). Session config updates are provider-typed in v1.

**Markers.** The `RealtimeSession` tag needs no marker for itself.
One marker meets the bar in `capabilities.md` (absence causes wrong
behaviour, one provider ships it, one does not): `RealtimeVideoInput`,
registered by Gemini only, so a `VideoFrame` against OpenAI is a type
error rather than a silent drop.

**Lifetime.** Explicit, not automatic. Gemini: the adapter always
asks for `sessionResumption`, surfaces `goAway` as `SessionEnding`
and each handle as a `ResumptionHandle` event; the request accepts
`resume: handle`, and reopening is the caller's move (an optional
`resumable` helper can wrap it later). OpenAI: `SessionEnding` before
`expires_at`; there is no resume, so hand-over is replaying text
history into a new session. Both: Gemini's 10-minute socket and
OpenAI's 60-minute session are adapter facts, not common config.

**Errors.** No adapter today maps `SocketError` (a 401 on upgrade) to
`AiError`; streams just end cleanly. The shared helper must map open
failures to `AuthFailed` / `Unavailable` / `Timeout`, and `AiError`
needs a session-expiry variant (`describe` is exhaustive on `_tag`).

**Transport.** WebSocket only for both providers in v1, server relay
topology for recipes (browser to our socket to the provider). OpenAI
WebRTC with a server sideband socket is the right production topology
for browser apps but is OpenAI-only and, as of 2026-09-09, requires the
call to be created with the same API key as the sideband. Document it,
do not build it. Ephemeral-token minting (`client_secrets`,
`auth_tokens`) is a provider-typed helper, later.

## Recipes

Server relay is the only topology both providers share and the only
one that exercises `RealtimeSession` end to end; it also lets a WAV, a
TTS persona or Twilio frames replace the microphone. Full evidence per
use case: [recipe-use-cases.md](./realtime/recipe-use-cases.md).

### Pick these

| Recipe                           | What it shows                                                                                                                                                                         | Features                                                                                                                                       | Mirrors                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `realtime-voice-agent`           | One duplex session where the model owns turn-taking and tool calls interleave with speech. `--provider openai\|google`, same browser client as voice-loop minus the stop-word watcher | server VAD, barge-in (OpenAI truncate bookkeeping, Gemini `interrupted`), `Toolkit` tools so `mcp-tools` plugs in, transcripts, text injection | `voice-loop`                                   |
| `voice-tool-approval`            | A sensitive tool call is gated by a human while the call stays live; the model keeps talking until the verdict lands. Approval is a button, not a spoken "yes"                        | async tool result, text injection of the verdict, OpenAI `mcp_approval_request` as the hosted variant                                          | `tool-call-approval`, `sleeper-agent`          |
| `camera-assistant` (Gemini only) | Frames are one more `RealtimeInput` variant at 1 fps JPEG; `--source camera\|screen` covers screen share                                                                              | `RealtimeVideoInput`, `mediaResolution`, `contextWindowCompression` (audio+video caps at 2 min), `goAway`                                      | `realtime-voice-agent`, `multimodal-embedding` |

Optional, smallest: `call-supervisor`, a second consumer of the shared
event stream that classifies the live call (`Stream.share` + a text
`LanguageModel`; OpenAI-native variant via out-of-band
`response.create`). Mirrors voice-loop's watcher fibre.

Landing order: `realtime-voice-agent` (OpenAI first, then Gemini),
then `voice-tool-approval`, `camera-assistant`. Most other voice use
cases (support, drive-through, tutoring, form filling, NPCs) are the
base recipe with a different prompt and toolset; only async tool
results, a second modality, a second consumer and telephony change
the composition.

### Reject

`simulated-caller` (a WAV or TTS persona as the user is a test
utility, not a use case: becomes a headless `--input file.wav` flag on
the base recipe and its `recipe.test.ts`); `realtime-vs-pipeline` (a
benchmark); `live-translator` (separate models and session types,
`gemini-3.5-live-translate-preview` and `gpt-realtime-translate` on
`/realtime/translations`, otherwise a system prompt); `phone-agent`
(needs a Twilio account and a public URL, and OpenAI SIP keeps media
out of process); `session-handoff` (Gemini-only lifecycle plumbing
that belongs inside the adapter); drive-through, form filling,
tutoring, game NPC (a prompt plus tools on recipe 1); meeting copilot
with proactive audio (2.5-only flag, identity-sensitive); warm
transfer (telephony resource management); accessibility reader (that
is `streaming-synthesis`); browser-direct or sideband transport recipe
(OpenAI-only plumbing, brittle).

## Repo audit: what exists and what is missing

Checked 2026-09-11 at `dev` HEAD; full detail with line references in
[repo-audit.md](./realtime/repo-audit.md).

Reusable as-is: `AudioFormat`; `ToolCall` / `ToolCallOutput` (Gemini
needs `JSON.stringify` of `args` and a `call_id` to `name` map for
`functionResponses`); `ImageSource` as the `VideoFrame` payload;
`Usage`; `Toolkit` declaration, descriptors, `decodeArgs`,
`Toolkit.run`, `Approval.fromQueue` (only the feedback path changes:
push into the socket, not history); Gemini's `functionDeclarations`
renderer once exported from `codec.ts`; the seven existing WebSocket
adapters' skeleton (`makeWebSocket` with the clean-close predicate,
`Queue.bounded<A, Cause.Done>` + `Queue.end`, fork-scoped writer and
reader, `parseSafe` then `Schema.Union` decode then `Match`); the
`ws`-based header auth constructor (openai) and the query-param global
constructor (elevenlabs, which is the pattern for Gemini's `?key=`, so
`@effect-uai/google` stays free of `ws`); `cdp.ts` as the only
id-correlated ack precedent (`setupComplete`, `session.updated`,
`response.done`); the voice-loop browser client (mic worklet, playback
worklet with `clear`, `/config` handshake, WebSocket queue bridge,
`bundleClient`, `serveRecipe`).

Missing: the `RealtimeSession` tag, `RealtimeInput` / `RealtimeEvent`
unions and the top-level helper; a shared WebSocket session helper
absorbing seven duplicated pieces across the adapters; `SocketError`
to `AiError` mapping and a session-expiry variant; both adapters;
realtime model unions in `models.ts` for openai and google; a
`MockRealtimeSession` in `core/testing`; an in-memory fake `WebSocket`
injected via `Socket.WebSocketConstructor` (no socket-level tests
exist at all today); browser-side positional playback truncation
(worklet only supports all-or-nothing `clear`), a 24 kHz-aware warmup
(hard-coded at 48 kHz), a camera frame sampler, a text input channel;
a `realtimeSessionLayer` picker in `recipes/_shared/model.ts`; docs
and site registration (`docs/realtime`, sidebar block, `stubPagePattern`
and llms exclude in `astro.config.mjs`, `Hero.astro` count,
`CapabilitiesSection.tsx` card, `PageTitle.astro` icon).

## Decisions to confirm

1. **Launch set: OpenAI + Google only**, extending existing packages;
   xAI and Azure as compatible endpoints documented as gateways over
   the OpenAI Realtime codec, not packages. Nova Sonic deferred to the
   Bedrock track, Hume to a second wave.
2. **Shape: explicit session handle.** `RealtimeSession.open(request)`
   returns `{ send, events }` scoped to the connection. Tool
   execution, playback, barge-in bookkeeping and reconnection are
   recipe code built from public pieces; no `withToolkit`, no hidden
   queue, no automatic reconnect in core. Decided 2026-09-11.
3. **One marker** (`RealtimeVideoInput`, Gemini only). Truncation,
   manual mode and mutability are adapter behaviour or provider-typed,
   not markers.
4. **WebSocket only**, server relay recipes. WebRTC / sideband and
   ephemeral tokens documented, not built.
5. **Fix the OpenAI realtime STT adapter first** (beta header, model
   ids) since it is likely broken in production today.

## Plan

The step-by-step implementation plan, with the final types, per-step
files, tests and done-criteria, is the handover document
[plans/realtime.md](../realtime.md). Order: (1) fix the OpenAI realtime
transcriber, (2) core capability and mock, (3) OpenAI adapter with the
shared WebSocket helper, (4) `realtime-voice-agent` on OpenAI, (5)
Gemini adapter and `--provider google`, (6) `voice-tool-approval`, (7)
`camera-assistant`, (8) docs and site, (9) optional follow-ups
(`call-supervisor`, `resumable` helper, headless WAV input, adapter
migration). Steps 1 through 5 plus 8 make the v0.13 item.

**Postponed:** Nova Sonic (`@effect-uai/bedrock`), Hume EVI, the
`preview` dialect for Qwen / StepFun, OpenAI WebRTC + sideband,
ephemeral-token helpers, session hand-over for OpenAI's 60-minute
limit, OpenAI image items in a realtime session, the translation
session types, migrating the seven existing WebSocket adapters onto
the shared helper, and `plans/websocket.md`'s text-only session.
