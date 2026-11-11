# Plan: `@effect-uai/ui` for streaming media, and the media recipes on it

Status: **planned**, follow-up PR 3 of the video work (see "PR split" in
`plans/video-generation.md`). Starts after the video capability (PR 1)
and the direct video providers (PR 2) have merged.

Scope: the ui package grows from chat to streaming media (program
streams, live duplex sessions, browser media), and the seven media
recipes move onto it, starting with the tv-station.

This plan supersedes "Phase 2: live sessions" in `plans/ui.md`, whose
description of the voice recipes is out of date in nine places (listed at
the end).

---

# Part 1: the tv-station recipe

The station was built on the video branch and is parked on the
`tv-station-parked` branch (commit "Add tv-station recipe",
`recipes-extras/tv-station`) until this PR. Its
original design is in the git history of `plans/video-generation.md`
(Phase 3). What carries over, and what changes.

## Carries over

- **The budget is the knob.** `--budget 30 --clip 6` means five clips;
  the cost estimate prints before anything is submitted; `--dry-run`
  plans and writes the manifest without spending. The default run ends;
  `--loop` replays from disk, `--infinite` lifts the cap.
- **Resume through the job ref.** `station.json` records each clip as
  `planned`, `submitted { ref }` or `done { file }`, written through
  `.partial` + rename, and the ref is persisted before the first poll. A
  restart collects the job already running on fal instead of paying
  twice.
- **Program generation in three stages**: optional `--search` research,
  one structured channel call (brainstorm `concepts`, then commit to
  `chosen`, with a random seed phrase), and segments planned three at a
  time. The brief comes from `--brief` / `--brief-file` only, never the
  page.
- **One house format, one live stream.** Every clip is re-encoded to
  720p24 H.264 + AAC and appended to a single fragmented MP4 on
  `GET /stream`, paced against the wall clock with a two-second lead; a
  late clip airs a one-second standby card instead of stalling.
  `GET /programme.mp4` assembles the finished clips.

## Changes in this PR

- **Control channel on `@effect-uai/ui`.** The hand-rolled `/ws` and the
  `ServerEvent` union written twice become a session stream (SSE) of
  `data` entries typed by a `UiContract`, folded by `StreamView`.
- **The station outlives the tab.** Today every WebSocket starts a fresh
  timeline at clip 0, a second tab gets a 409, and closing the tab stops
  production. The station moves into a layer-owned fiber publishing into
  a replaying `PubSub` (the `durable-chat` shape); Play is an input.
- **The planner is a visible run.** Project it with
  `Projection.toRunEvents` as a named run next to the program, which
  needs concurrent runs (gap 3).
- **Port fixes found on the way:** stale `effect/unstable/http` imports,
  `--rehearse` renumbering clips after filtering, `clip-start` sent at
  encode time rather than air time, and `model.ts` forked from
  `recipes/_shared/model.ts`.

---

# Part 2: the ui package

## What the recipes do today

Seven recipes have a media client. None uses `@effect-uai/ui`.

| recipe                    | wire                       | server to client                                                | client to server                       | media                              |
| ------------------------- | -------------------------- | --------------------------------------------------------------- | -------------------------------------- | ---------------------------------- |
| `radio-station`           | WS                         | `station-info`, `track-planned/start/end` + MP3 binary          | `track-ended` (no index)               | MP3 into one MSE buffer, ack-gated |
| `tv-station`              | WS (JSON) + HTTP `/stream` | `station-info`, `clip-planned/ready/start`, `standby`           | nothing                                | fMP4 over HTTP, wall-clock paced   |
| `streaming-synthesis`     | WS                         | PCM s16le 48k only, no boundaries, no errors                    | `{ text }`                             | playback worklet                   |
| `streaming-transcription` | WS                         | raw `TranscriptEvent` JSON                                      | mic PCM 16k / 24k                      | mic worklet                        |
| `voice-loop`              | WS                         | `user-partial/final`, `assistant-*`, `error` + TTS PCM          | mic PCM                                | both worklets                      |
| `realtime-voice-agent`    | WS, 1-byte tags            | `user-transcript`, `assistant-*`, `tool-*`, `interrupted` + PCM | `0x00` audio, `0x01` text, `0x02` ms   | both worklets                      |
| `camera-assistant`        | WS, 1-byte tags            | the realtime set minus `speech-started`, plus `frames`          | `0x00` audio, `0x01` text, `0x02` JPEG | both worklets + camera             |

CLI recipes with a natural client: `storyboard` (already a
`Stream<BoardEvent>` carrying images), `conversational-image-edit`
(streamed preview images), and the `basic-*` speech, transcription and
music recipes.

What repeats, and what breaks:

- **The WebSocket handler** (two queues, `upgradeChannel`, `Queue.end`,
  the `SocketError` catch) exists seven times, 38 to 85 lines each.
- **Event unions are written twice**, server and client, with no schema,
  no ids and no `seq`. Nothing survives a reload: radio and tv restart
  their program at item 0 on every connection, the voice recipes lose the
  session.
- **`upgradeChannel` delivers every inbound frame as bytes**, so recipes
  invent tag bytes, and `0x02` means playback position in one recipe and
  JPEG in another.
- **Worklets are copied** (the mic worklet byte-identical three times)
  with real bugs: the "averaging" decimator picks samples and aliases, the
  player never re-warms after an underrun and never starts a reply shorter
  than its warmup, the PCM converter throws on an odd-length chunk.
- **Core events are dropped on the way out**: usage, VAD stop, response
  and call ids, tool outputs, resumption handles, word timestamps.
- **Formats travel out of band**: `/config` routes return sample rates the
  client must trust.

## What `@effect-uai/ui` already covers

More than expected. The package has two layers, and only the top one is
chat-shaped:

- **Generic:** `Envelope { streamId, seq, runId? }`, the `Run` operators,
  `SseEncoding`, `Client.resumable`, `Transport.session` + `reconnect`,
  `Atoms.session` over any fold, and two stream-scoped payload events
  typed by `UiContract`: `data` (upsert by id) and `live` (latest wins).
- **Chat:** `Thread`, `RunView`, the `Input` preset, `Projection.toRunEvents`.

A station is a session whose stream carries stream-scoped `data` entries
and the occasional run. A clip is `data { name: "clip", id: "3", value }`,
and the upsert gives it in-place transitions (planned, rendering, ready,
on air). A transcript partial is a snapshot upsert of its utterance's id.

So the rule: **no media-specific state in the protocol; extend the
generic layer, leave `Thread` and `RunView` alone.**

## Gaps and the design for each

Each item is one elementary piece. All additive except the protocol
version (see Compatibility).

**1. A `media` event.** `image` exists; audio, video and files have no
event, so a tool or job that produces a clip has nothing to emit.

```ts
export const Media = event("media", {
  source: MediaSource, // core: url | base64 | bytes
  id: Schema.optional(Schema.String), // repeated id replaces in place, like `data`
  name: Schema.optional(Schema.String),
})
```

The MIME type says the kind, as with the planned `input_file`. Docs say:
send a URL the app serves; bytes are for small files. `RunView` gains a
`media` block; a stream-scoped `media` lands in `StreamView` (item 4).
`image` stays as is, since it is core's `OutputImage`.

**2. Job state is `data`, not a new event.** A generation in flight is an
app entry: `data { name: "clip", id, value: { job, title, ... } }`. The
contract types it with a new core `Job.JobStateSchema(result, error)`
(U1), shaped like `RunEvent.outcome(value, error)`: `AiError` has no
schema, so the app picks how a failure crosses the wire;
`Job.watch` already shipped in PR 1. No ui helper: mapping
a state onto `data` is one line.

**3. Concurrent runs on one stream.** `Run.sequence` takes the run id from
the last `run-started`, so two runs merged before sequencing are
mislabelled. The station needs it (planner run next to the program), and
so do voice side runs (a reviewer scoring the user's turn while the reply
plays).

```ts
// tag each run's events with its id, merge, sequence once
Run.within(runId): (self: Stream<RunEvent>) => Stream<Owned> // Owned = { runId?, event }
Run.sequenceOwned(streamId, { from? }): (self: Stream<Owned>) => Stream<Envelope>
```

`Run.start` / `Run.complete` stay per run, applied before `within`.
`Run.sequence` is unchanged for the single-run case.

**4. A stream fold, `StreamView`.** `RunView` folds one run and `Thread`
a chat. Add an optional fold for any session stream:

```ts
type StreamView<P> = {
  readonly streamId: StreamId | null
  readonly lastSeq: number
  readonly runs: Record<RunId, RunView<P>> // concurrent; `run-started.name` labels them
  readonly order: ReadonlyArray<RunId>
  readonly data: Record<string, Record<string, DataValue<P>>> // by name, then id
  readonly media: Record<string, MediaEntry> // stream-scoped `media`
  readonly live: Live<P>
  readonly channels: Record<number, ChannelInfo> // item 6
}
```

`StreamView.initial` and `step`: pure, total, idempotent on `seq`, typed
by the contract like `Thread`. Plugs into `Atoms.session` unchanged, since
that already takes any fold. This replaces the `VoiceSession` fold
`plans/ui.md` planned: a voice session is a stream with concurrent runs
and a transcript entry, so nothing voice-specific is left to fold.

**5. Durable program streams need no library code.** A station or radio
outlives its tab by running in a layer-owned fiber that publishes into a
`PubSub` with replay, exactly as `durable-chat` does. Viewers follow with
`Transport.session` + `reconnect`; Play is an input through `send`. Media
bytes stay on plain HTTP: tv keeps `/stream`, and the radio moves to the
same shape (a server-paced `audio/mpeg` response), which removes its MSE
append queue and the index-less ack.

**6. Live duplex sessions.** When media flows continuously (mic, camera,
TTS, realtime), SSE plus POST is the wrong shape: the upstream is itself
a stream. Pieces:

- **`Frame` codec** (protocol). One WebSocket message is one tagged frame,
  which restores the text/binary distinction `upgradeChannel` loses:
  - `0x00` + UTF-8 JSON: an `Envelope` downstream, an upstream message
    upstream.
  - `0x01` + `u16 channel` + payload: media bytes on a channel.

  `Frame.encode`, `Frame.decode`, plus stream versions. Media frames are
  unsequenced and never logged.

- **Channel events** (stream- or run-scoped):
  `channel-opened { channel, mimeType, sampleRate?, channels? }` and
  `channel-closed { channel }`. The format is declared on the stream, so
  the `/config` routes go. A TTS reply opens its channel inside its run,
  so stopping the run tells the client which channel to clear.
- **Upstream messages are app-defined**, like `Input`. Presets:
  `Input.Submit` (typed text), `Playback { channel, playedMs }`,
  `PlaybackEnded { channel }`. Client media goes up on channels the app
  numbers.
- **Server: `LiveSocket.handle(handler)`**, where
  `handler: (up: Stream<Upstream>) => Stream<Down>` and
  `Down = Envelope | MediaFrame`. It returns the upgrade response and
  replaces the seven handlers. The handler is a plain stream transformer,
  so the recipe stays explicit and testable without a socket.
- **Client: `Transport.live({ connect })`** with
  `connect: (up: Stream<Up>) => Stream<Down>`, plus `Transport.socket(url)`
  on Effect's `Socket`. `Atoms.live({ transport, step, media })` exposes
  `state`, `connect` and `send`. Media frames never pass through atoms;
  they go to `media: (frame) => Effect`, which the app points at a sink.
- **`run-stopped` gets an optional `reason`** (`"barge-in"`, `"user"`).
- **No resume for live sessions yet.** Envelopes keep `seq`, so it can
  come later; provider resumption handles are a separate core item.

**7. Browser media: `@effect-uai/ui/Media`.** A browser-only subpath,
not exported from the index. Effect Streams and Sinks that own the
plumbing each recipe copies, with the bugs fixed:

- `mic({ sampleRate, echoCancellation, ... }): Stream<Uint8Array, MediaError, Scope>`:
  s16le, low-pass before decimation, the muted `<audio>` anchor
  workaround, teardown via scope. The worklet ships inline (Blob URL), so
  no extra route.
- `camera({ source: "camera" | "screen", fps, maxSide, quality }): Stream<Uint8Array>`:
  JPEG frames.
- `level(audio): Stream<number>`: an RMS tap for meters and gates.
- `pcmPlayer({ sampleRate }): { sink, clear, played }`: carries odd bytes
  across chunks, re-warms after an underrun, starts replies shorter than
  the warmup; `played` is a `Stream<Duration>` for `Playback` upstream.

Stays app code: loudness gates (`Stream.zipLatest` with `level`), frame
budgets, stop words, pacing, phonetic rewrites.

**8. Projections from core media events** (server, in `Projection`).
Fold pairs like `toRunEvents`, so an app wraps or replaces them:

- `fromTranscript`: `TranscriptEvent` to `data "transcript"` keyed by an
  utterance id it assigns (partials share the id until their `final`),
  words included. It expects snapshots: delta providers go through
  `Transcript.accumulatePartials` first, in the app's pipeline, visibly.
- `fromRealtime`: `RealtimeEvent` to one run per `responseId` (text
  deltas, tool events, usage on `ResponseDone`,
  `run-stopped { reason: "barge-in" }` on `Interrupted`), `live "vad"`,
  and audio as media frames on the run's channel. It outputs `Down`, not
  `RunEvent`, because it carries bytes.
- The realtime tool fork/cancel helper stays the core backlog item; the
  projection only reports tool events.

**9. Core prerequisites.** `Job.JobStateSchema` (U1; `Job.watch` is in PR 1);
`Audio.Pcm` (`s16ToF32`, `f32ToS16`, a carry-aware chunker), shared by the
server (voice-loop's f32le conversion) and `Media` (U3).

## Recipe mapping

| recipe                                   | transport                   | fold         | pieces used                                                                                 |
| ---------------------------------------- | --------------------------- | ------------ | ------------------------------------------------------------------------------------------- |
| `tv-station`                             | `session` (SSE) + HTTP fMP4 | `StreamView` | `data` clips carrying `JobState`, planner run via `Run.within`, `media` for finished clips  |
| `radio-station`                          | `session` + HTTP audio      | `StreamView` | `data` tracks, `media`                                                                      |
| `storyboard` (new client)                | `session`                   | `StreamView` | `data` panels, `image`                                                                      |
| `conversational-image-edit` (new client) | `durable` or `session`      | `Thread`     | `image` (exists)                                                                            |
| `streaming-transcription`                | `live`                      | `StreamView` | `mic`, `fromTranscript`                                                                     |
| `streaming-synthesis`                    | `live`                      | `StreamView` | a run per utterance, a channel per run, `pcmPlayer`                                         |
| `voice-loop`                             | `live`                      | `StreamView` | `mic`, `fromTranscript`, `toRunEvents` per reply, a channel per reply, barge-in, `Playback` |
| `realtime-voice-agent`                   | `live`                      | `StreamView` | `mic`, `fromRealtime`, `Playback`                                                           |
| `camera-assistant`                       | `live`                      | `StreamView` | `mic`, `camera`, `level`, `fromRealtime`                                                    |

## Order

1. **U1, program streams** (the tv-station needs it): `media` event and
   block, `Run.within` + `sequenceOwned`, `StreamView`. Port tv-station,
   then radio-station.
2. **U2, live duplex**: `Frame`, channel events, `run-stopped.reason`,
   upstream presets, `LiveSocket.handle`, `Transport.live` / `socket`,
   `Atoms.live`. Port streaming-transcription and streaming-synthesis, the
   two smallest live recipes.
3. **U3, browser media and projections**: `Media`, `Audio.Pcm`,
   `fromTranscript`, `fromRealtime`. Port voice-loop, realtime-voice-agent,
   camera-assistant.
4. **Later**: storyboard and image-edit clients, TTS alignment and
   `heardText`, live resume.

Each step ends with its recipes verified in a browser and any gap they
still show written back here.

## Compatibility

- `Thread`, `RunView`, the existing transports and atoms, and every
  existing event are unchanged.
- New event types are still a protocol change: an older client fails on
  an unknown `type`, and `run-started.protocol` is a literal. Bump
  `PROTOCOL_VERSION` to 3 in U1. Client and server ship together in the
  fixed group, so this is a changeset note, not a migration.

## Rejected

- **A `Station`, `VoiceSession` or player module** that owns the
  program, pacing or barge-in: app policy, rejected for the same reason
  as the server `Session` module in `plans/ui-0.20-session-fixes.md`.
- **Media bytes in the event log**, or base64 audio in JSON: no replay
  value and a third more bytes.
- **Separate `audio` and `video` events**: same shape; the MIME type says
  the kind.
- **A job event family**: `data` upsert already models an entry that
  changes.
- **The registered frame-kind table** (`audio-in`, `video-frame`, ...)
  from `plans/ui.md`: channels declared by events are enough, and their
  numbering is the app's.
- **Auto-detecting formats or resampling to what a provider wants**: the
  app states rates; `mic({ sampleRate })` resamples only to what it is
  told.

## Where `plans/ui.md` Phase 2 is out of date

1. `run-stopped { by: "barge-in" }` and `tool-cancelled` are described as
   reserved in v1; neither exists (`run-stopped` is `{}`, cancelled tools
   end as `tool-result`). Its v1 table also lists `run-failed.retryable`,
   `run-started.messageId` and `tool-progress`, none of which shipped.
2. No recipe regroups LLM deltas into clauses before TTS; deltas go
   straight through.
3. Playback-position truncation works on OpenAI only; Gemini drops it
   with a warning, and a barge-in after `response.done` emits no
   `interrupted` at all.
4. The voice-loop playback worklet differs in behaviour, not just
   slightly: hard-coded warmup, no position reports, no `reset`.
5. voice-loop has no follow-scroll; the other two differ.
6. The WebSocket handlers are 40 to 85 lines, not 40 to 65; the tool
   fork/cancel code is about 50 lines, not 75.
7. voice-loop's `Effect.sleep` pacing keeps the turn fiber interruptible;
   no position is derived from it, and the cancelled text is what was
   generated, not what was heard.
8. `Encoding.toWebSocketDuplex` and `Transport.live` do not exist yet.
9. The list of dropped core events is incomplete: also every
   `responseId` and `call_id`, tool outputs and failures,
   `SessionEnding.timeLeft`, `Error.code`, and in voice-loop the STT VAD
   and word events and every `TurnEvent` except `TextDelta`.
