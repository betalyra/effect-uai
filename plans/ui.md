# Plan: `@effect-uai/ui` (agentic UI primitives: protocol, resumable runs, state, atoms)

Status: **plan, not started** (2026-11-06). Grounded in the
`@effect-uai/ai-sdk` compat layer, `examples/ai-sdk-next`, the voice recipes
(`voice-loop`, `realtime-voice-agent`, `camera-assistant`), the "explicit
loop" philosophy (`docs/start/why.md`), and prior art (TanStack AI 1.x, AI SDK
7, FoldKit 0.170, assistant-ui, Electric Durable Streams, Cloudflare `ai-chat`,
AG-UI). Experimental directions (generative UI, MCP Apps, WebMCP) shape the
extension points, not v1.

## Why

effect-uai has a server-side story for agents (the loop, `InteractionEvent`,
`ToolEvent`, `MetricEvent`, `RealtimeSession`, STT/TTS) but no client story
apart from `@effect-uai/ai-sdk`, which means adopting the AI SDK's `useChat`.
The voice recipes show the cost: each hand-rolls a WebSocket protocol, a
`StatusEvent` union with no ids, and ~330 lines of imperative client code,
~900 duplicated lines across three recipes.

What's missing is an effect-uai-native frontend layer: a small wire protocol,
the projection from the loop onto it, a resumable "replay then tail"
contract, and state primitives that any frontend framework can bind to.

**The main use case, and the v1 target, is the agentic chat**: a user sends a
message, the agent streams text, reasoning and structured objects, calls tools
(tool cards, sometimes gated by approval), reports usage, and can be stopped.
v1 makes that path short and fully explicit, as a plain request/response
stream and as a durable run that survives a refresh.

Voice and media (phase 2) and generative UI, MCP Apps, WebMCP (phase 3+) get
reserved extension points now, so they land additively.

## Roadmap

| Phase | Scope |
|---|---|
| **v1** | Chat: protocol, projection, run fold, optional `Thread`, structured-object streaming, direct + durable transports over SSE/NDJSON, `EventLog`, atoms, React via `@effect/atom-react` (no own package) |
| **v2** | Live sessions: multi-run streams, session-scoped events (user transcripts, VAD, interruption), a binary side channel for audio and video, upstream media streams, browser audio/camera helpers, `WebSocket` duplex transport. Port the three voice recipes |
| **v3+** | Generative-UI state channel, rendering MCP Apps tool UIs (MCP work itself is tracked in `plans/backlog.md`), media output blocks beyond images, long-poll and RPC wires, FoldKit recipe, WebMCP if it matures |

## Design principles

1. **Direct and durable runs share one set of primitives.** The protocol,
   projection, fold and atoms are identical; only the transport and the
   presence of an event log differ.
2. **Layered for frameworks.** Pure Effect core (protocol, streams, folds) →
   framework-neutral atoms (`effect/reactivity`) → framework bindings, which are
   the official `@effect/atom-*` packages. FoldKit plugs in at the first layer.
3. **A run is the central concept.** One agent invocation that emits
   `RunEvent`s and ends with exactly one terminal. `RunView` folds it.
   Everything above it (`Thread`, a voice session, a dashboard) is an optional,
   replaceable fold.
4. **Open data, no black boxes.** State types are plain Schema-backed records,
   step functions are exported and pure, every model above `RunView` is
   optional, and request shaping is the app's function. Apps can drop any layer
   and write their own fold over envelopes.
5. **Orchestration is a recipe, not a library runner.** Forking into a
   `FiberMap`, input queue policy, `onFinish` persistence and stop wiring are
   app policy, the kind of lifecycle box `why.md` argues against. Library code
   covers what is subtle and identical everywhere: seq assignment, the
   "exactly one terminal" guarantee, the replay-then-tail reader, client
   reconnect.
6. **The protocol covers what the loop already emits.** Tool progress,
   approvals, tool outputs, citations, images and structured objects get
   protocol events. Approvals become **interrupts in state**, not callbacks.
7. **Projection is a per-event function you can wrap**, not an opaque stream
   operator. App events (metrics, domain events) map through the same function.
8. **The fold is the product.** Pure, total `step(view, envelope)`;
   replay, tests, devtools and FoldKit fall out of it (AI SDK's biggest black
   box is the imperative accumulator inside `AbstractChat`).
9. **Lifecycle is explicit: submit, stop, resume, resolve.** Each is a
   transport capability with defined semantics per mode, never an implicit
   side effect.
10. **Extension points, not features.** Envelopes are keyed by stream (not
    run), inputs carry ids, tool events have room for a UI reference, the
    encoding reserves a binary side channel, and folds are generic over app
    payloads. None of it costs the chat path anything.

## Prior art, in one table

| | Client core | Framework seam | Resume | Takeaway |
|---|---|---|---|---|
| AI SDK 7 `useChat` | `AbstractChat` class, mutable `ChatState` | framework injects a reactive state container | `reconnectToStream`, whole stream or nothing, Redis `resumable-stream`; stop needs your own endpoint | Copy the 2-method transport seam. Avoid the hidden accumulator and callback hooks (`onToolCall`, `sendAutomaticallyWhen`). |
| TanStack AI 1.x | headless `ChatClient` (`getSnapshot`/`subscribeSnapshot`) | thin react/solid/vue/svelte packages | first-class `StreamDurability` adapter, per-run log, opaque offsets as SSE ids, `resumeFrom()` guard | Best layering and durability model. But the client is a god-class (queueing, persistence, paging, BYOK), and its run log competes with an app-owned one. Interrupts (`RUN_FINISHED.outcome = interrupt`) model approvals well. AG-UI events as wire format. |
| assistant-ui `ExternalStoreRuntime` | you own state; pass `messages`, `isRunning`, `onNew`, `onCancel`, ... | n/a | n/a | Cleanest "UI = state + intents" split. A future adapter target. |
| Electric Durable Streams | HTTP log protocol, `?offset=`, `Stream-Up-To-Date`, live SSE/long-poll | n/a | the whole point | Mirror its semantics (monotonic offset, catch-up then live tail, explicit end) so a backend swap is server-only. |
| FoldKit | Elm architecture on Effect: Schema model, `update`, Commands (Effect → Msg), Subscriptions (`Stream<Msg>` keyed by model deps) | n/a | n/a | Needs exactly: a state Schema, a pure step function, "submit" as an Effect, "tail run from seq" as a Stream. Atoms would fight it. |
| Effect Atom (`effect/reactivity`, stable in 4.x) | `AtomRegistry` is framework-free (`get`/`set`/`subscribe`/`toStream`) | official `@effect/atom-react`, `-vue`, `-solid` at 4.1.2 | n/a | Atoms are our "vanilla JS" layer. Svelte and plain JS bind via `registry.subscribe`. |

## Lessons from `@effect-uai/ai-sdk` and `examples/ai-sdk-next`

The compat package is half of this design for the AI SDK: a projection
(`InteractionEvent` → UIMessage parts, synthesizing block ids per turn) plus an
inbound decoder (`UIMessage[]` → `HistoryItem[]`). `@effect-uai/ui` is the same
shape with our own protocol, plus the client side the compat layer leaves to
`useChat`. It does not replace the compat package.

`examples/ai-sdk-next` (tool loop, model fallback, live metrics, usage
metadata, Stop) is the reference feature set v1 must cover without glue:

1. **The projection must accept more than `InteractionEvent`.** The route
   hand-writes `toEmission` to merge `TurnEvent | ToolEvent | MetricEvent`.
2. **Stop differs per mode.** In direct mode Stop is the client aborting the
   fetch and the server interrupting on `request.signal` (`whenAborted` in the
   example; `mid-stream-abort` rolls its own; core has no helper).
3. **Client state needs** a `submitted` status, a transient channel (the live
   TTFT/tok/s badge), and settled per-message metadata (the usage footer).
4. **Model fallback mid-stream** can leave partial text on screen; the
   protocol needs a way to discard a partial step.
5. **Client-owned history works**: `decodeMessages` rebuilds history including
   tool calls and outputs. The `providerData` caveat below applies.

## Modes: where generation lives × what carries the events

Two independent axes. Socket is a wire, not a mode.

**Where generation lives**

| Mode | Generation | Stream | Phase |
|---|---|---|---|
| **Direct** | inside the request; dies with it | the response body | v1 |
| **Durable** | detached from the connection (layer-owned fiber); clients attach | submit returns `streamId`; subscribe replays then tails | v1 |
| **Local** | same process as the UI, no network (browser agent with BYOK, Electron, tests, Storybook) | the agent's stream, projected in-process | v1 (`Transport.local`, a few lines; doubles as the test transport) |
| **Live session** | long-lived, bidirectional, many runs, continuous upstream (voice, camera) | one duplex connection | v2 |

**What carries the events**

| Wire | Direct | Durable | Phase |
|---|---|---|---|
| SSE (fetch or `EventSource`) | ✓ | ✓ | v1 |
| NDJSON over fetch | ✓ | ✓ | v1 |
| WebSocket (JSON + binary side channel) | ✓ | ✓ | v1 JSON only, binary in v2 |
| Long-poll (`?after=N&live=long-poll`, Durable Streams style) | n/a | ✓ | later |
| RPC / server functions (Effect RPC streaming, TanStack Start server fns, tRPC subscriptions) | ✓ | ✓ | later |

Long-poll and RPC need no protocol change: envelopes already carry `seq`, and
every client source yields `Stream<Envelope>`. v1 ships the generic seam
`Transport.fromStream((input) => Stream<Envelope>)`, which RPC and server
functions plug into directly; a dedicated long-poll source and an Effect RPC
schema helper come later.

History caveat for client-owned history: `HistoryItem` is a Schema, so the
client can post it verbatim. But `providerData` (encrypted reasoning, item ids)
must not round-trip through the browser, so reasoning-model apps should prefer
server-owned history. Document this; don't paper over it.

## Lifecycle (v1)

| Intent | Direct | Durable |
|---|---|---|
| **submit** | POST; the response body is the run | POST returns `streamId`; the client then tails |
| **stop** | client aborts the fetch; server `interruptOnAbort(request.signal)`; `withTerminal` emits `run-stopped` (set locally if the connection is already gone) | explicit `stop(streamId)`; the owner interrupts the fiber; `run-stopped` lands in the log. A disconnect is **never** a stop |
| **resume** | absent from the transport type; a dropped stream ends as `run-failed { reason: "disconnected", retryable }` locally | `Client.resumable` reconnects from `lastSeq` on a `Schedule`; a fresh page tails from 0 (`step` is idempotent on `seq`) |
| **resolve** (approvals) | a new submit carrying the decisions plus history | `resolve(streamId, decisions)`; the server continues the loop into a new run |
| **submit while busy** | client-side choice, explicit on the atom: `busy: "block" \| "stop-then-submit" \| "queue-local"`. A second concurrent POST would run on stale history, so there is no silent default | the server's queue policy decides (queue, batch, interrupt, reject). The client shows the input as pending until `run-started { inputs }` lists it |

## Streaming structured output

One concept covers the three shapes, so a single object is a special case of
an object stream:

| Shape | Server source | Wire | Example |
|---|---|---|---|
| **Final object** | server-enforced structured output, `Turn.toStructured` at `TurnComplete` | one `object-done` | an extraction result |
| **Partial object** | one object growing as the model writes it (partial JSON parse) | `object-started` → `object-delta`* → `object-done` | a form or card filling in (AI SDK `streamObject`) |
| **Object stream** | JSONL, `StructuredFormat.decodeJsonLines` | per element: `object-done`, or `object-started` → `object-delta`* → `object-done` | a list of recipes appearing one by one |

**Protocol.** Each object has an `id` and an optional `name` (which schema or
list it belongs to). `object-delta { id, patch }` carries an RFC 6902 JSON
Patch against the previous partial value, the same format AG-UI uses for
`STATE_DELTA`, so a later AG-UI projection maps it directly. Mid-stream, the
server may send `object-delta { id, value }` (a snapshot) instead when a patch
would be larger than the value, e.g. after a reset. `object-done { id, value }`
always carries the full validated value, so the final state never depends on
patch correctness. `object-failed { id, issues }` reports a validation
failure; a retry continues with `step-reset` or a new object id. A list is
objects sharing a `name`, ordered by first appearance.

**No extra library.** `effect/JsonPatch` (stable since 4.0) covers both
sides: `JsonPatch.get(previous, next)` computes the patch on the server,
`JsonPatch.apply(patch, value)` applies it in `step`. It implements the
`add` / `remove` / `replace` subset (including `add` at `/-` for array
append), which is all a growing object needs; the server never emits other
ops. `apply` throws on an invalid patch, so `step` catches it and marks the
object as needing the next snapshot or `object-done`.

**Server (core addition).** `StructuredFormat.decodePartial(format)`:
`Stream<string>` → `Stream<Partial | Done | Failed>`, an incremental JSON
parser yielding deep-partial unvalidated values and the validated final.
Lives in `@effect-uai/core` (it is useful without any UI), next to
`decodeJsonLines`. The projection gains `Projection.objects(format, { mode:
"final" | "partial" | "elements", name })`, which turns text deltas into
object events and leaves non-object events alone.

**Client.** `RunView` gets `object` blocks `{ id, name, status: partial |
done | failed, value }`. `step` applies patches; the final value replaces
the partial. Typed access is opt-in: share the Schema with the client and use
`RunView.objects(view, name, Schema)` to get `ReadonlyArray<{ status, value:
DeepPartial<A> | A }>`. The same block powers tool-result-as-component UIs.

## `Thread`: optional reference model, not core truth

The required core is the protocol, `RunView` and the transports. `Thread` is
an optional module in the same package: a reference fold for the most common
UI (a message list plus the active run), plain open data, pure functions, no
hidden state. Apps that need something else (a canvas, a dashboard, a voice
session, a ticket view) fold `RunView` into their own model and skip
`Thread` entirely. It sits on the border between generic and app-specific,
which is why it is optional and replaceable rather than absent:

- **Folds are `initial` + `step` pairs.** Effect has no fold type, only the
  functions that take the pair (`Stream.scan`, `Stream.runFold`,
  `Sink.foldLeft`). Each model exports both halves (`RunView.initial` /
  `RunView.step`, `Thread.initial` / `Thread.step`), usable directly as
  `envelopes.pipe(Stream.scan(RunView.initial, RunView.step))`.
- **Atoms take a fold.** `Atoms.make({ transport, initial, step })` is the
  primitive; `Atoms.thread({ transport })` is that with `Thread`'s pair. A
  custom model is a different pair.
- **The active run** inside a thread is `thread.active: RunView | null`
  (finished runs settle into `thread.messages`).
- **Open types.** `Thread<Meta, Data>`: messages carry app metadata (`Meta`),
  and `data` / `live` payloads are app schemas.
- **Intents are pure functions**: `submitted(thread, input)` (optimistic),
  `settle(thread)`, `truncateAfter(thread, messageId)` (regenerate and edit are
  truncate + submit), `withPersisted(persisted, run)` (merge server history
  with a live run, previously a React hook).
- **Extra request data.** The transport's request builder is app code:
  `Transport.direct({ request: (input, state) => Request })`, so any body,
  header or query (model choice, language, chat id, attachments) goes in.
  Inputs also carry an open `metadata` field for data that should travel with
  the input itself and be echoed in `run-started`.

## Shared types between server and client

One contract value built from Schemas, imported by both sides (the pattern
of Effect's `HttpApi` / `Rpc`). Types come from `Schema.Type`; there is no
hand-written generic triple (AI SDK's `UIMessage<Metadata, DataParts,
InferUITools<typeof tools>>` threaded through `useChat<…>`), and runtime
validation comes with it.

```ts
// shared/ui.ts: Schemas only, no server code
export const GetWeather = {
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({ city: Schema.String, temperatureC: Schema.Number, observedAt: Schema.Date }),
} as const

export const ChatUi = UiContract.make({
  tools: [GetWeather],
  objects: { recipe: Recipe },
  data: { sources: Sources },
  live: { metrics: Schema.Struct({ tokps: Schema.Number }) },
  metadata: { run: RunMeta },
})
```

- **Server:** `Tool.make({ ...GetWeather, run })` (the spec is spread; `run`
  must return the output type). `Projection.toRunEvents(ChatUi)` encodes
  payloads through the contract; `ChatUi.data(name, value)` /
  `ChatUi.live(name, value)` are typed constructors, so a wrong name or
  payload fails to compile.
- **Client:** `RunView.make(ChatUi)` / `Atoms.thread({ transport, contract:
  ChatUi })`. Tool blocks are a union generated from the contract: narrowing
  `b.name === "get_weather"` types `b.input` and `b.output` (decoded, e.g.
  `observedAt` is a `Date`). `view.live.metrics`, `RunView.objects(view,
  "recipe")` are typed without passing Schemas at the call site. The one
  mapped type lives inside the library, not in user code.
- **Unknown names stay untyped, not rejected:** a tool, object or data name
  the contract doesn't know becomes an untyped fallback block, so a newer
  server can roll out before older clients.
- **Validation cost:** the client decodes only settled payloads
  (`tool-result`, `object-done`, `data`, `live`). Text, reasoning and partial
  objects pass through untouched. `decode: "validate" | "trust"` per contract.
- **Fully optional:** without a contract, `RunView.initial` / `RunView.step`
  behave as described above (untyped payloads).

### Core prerequisite: `outputSchema` on local tools

Core `Tool` has `inputSchema` but infers `Output` from `run`, so nothing
validates what a tool returns. Add an optional `outputSchema`:

- `Tool` type: `readonly outputSchema?: Schema.Codec<Output, any, never, any>`.
- `Tool.make`: one more overload; with both schemas given, `Output` is
  `O["Type"]` and `run` must return it.
- `Toolkit` `executeOne`: on success, encode the value through
  `outputSchema` before `okResult`. Encoding validates, so malformed tool
  output becomes an explicit `output_encoding` failure the model sees and can
  react to, instead of silently passing through (the AI SDK behavior). It also
  fixes serialization of `Date`, `Uint8Array` and branded types for the model.
- `Tool.toDescriptors`: optionally expose the output JSON Schema (MCP tool
  definitions have an `outputSchema` field).
- Fully backward compatible: tools without `outputSchema` behave as today.

The tool spec is the contract, so `UiContract.make({ tools: [GetWeather] })`
takes it directly; there is no parallel contract schema that could drift.

## Packages

### `@effect-uai/ui` (v1): Effect-only, browser- and server-safe

No `node:` imports anywhere. Depends on `effect` and `@effect-uai/core` only.
No UI components: the README states "state and streams, not components" up
front.

**Protocol and projection (shared)**

| Module | Content |
|---|---|
| `RunEvent` | Schema union, wire protocol v1. Every frame is an `Envelope { streamId, seq, runId?, event }`; `seq` is per stream, starts at 1, monotonic, never reused. `runId` is set on every run-scoped event and absent on stream-scoped ones, so concurrent runs can interleave in one stream (v1 has one run per stream, but the wire shape is fixed now). Events:<br>**Run lifecycle:** `run-started { runId, name?, messageId, inputs: InputId[], protocol: 1 }` (`name` labels the run's role when a stream carries several, e.g. "assistant" vs a background "reviewer"); terminals, exactly one per run: `run-completed { metadata? }`, `run-interrupted { interrupts }` (approvals, later client tools), `run-failed { reason, retryable }`, `run-stopped { by?: "user" \| "barge-in" }`.<br>**Steps:** `step-started` / `step-finished { usage? }`; `step-reset` (discard the current step's partial output).<br>**Content:** `text-delta { text }`; `reasoning-started`, opt-in `reasoning-delta { text, kind }`; opt-in `citation`, `image`.<br>**Objects:** `object-started { id, name? }`, `object-delta { id, patch }`, `object-done { id, value }`, `object-failed { id, issues }`.<br>**Tools:** `tool-call-started { callId, name }`, opt-in `tool-call-args-delta`, `tool-call-ready { callId, input, ui? }`, `tool-progress { callId, data }`, `tool-result { callId, output, isError, ui? }`, `tool-cancelled { callIds }`. `ui` is reserved for MCP Apps.<br>**App and metrics:** `usage { usage }`; `data { name, value, id? }` (persisted, same id reconciles); `live { name, value }` (transient, latest wins). |
| `UiContract` | Optional shared contract (see "Shared types between server and client"): `make({ tools, objects, data, live, metadata })`, typed `data` / `live` constructors, and the generated block types used by `RunView.make(contract)`. |
| `Input` | Client-to-server Schema: `{ id, kind: "message", text, attachments?, metadata? }` \| `{ id, kind: "resolve", decisions, metadata? }`. `id` is client-generated so optimistic UI reconciles with `run-started { inputs }`. Further kinds (`action`, media streams) are extension points. |
| `Projection` | Per-event functions `fromTurnEvent`, `fromToolEvent`, `fromInteractionEvent` returning `ReadonlyArray<RunEvent>`, the operator `toRunEvents(options)`, and `objects(format, options)`. Users wrap the per-event function (`Match` over their wider union, `orElse` to ours). Never forwards `TurnComplete.turn` (it carries `providerData`). |
| `Run` | Server-side stream helpers, piped like the metrics helpers: `sequence(fromSeq?)`, `withTerminal({ runId, inputs })` (brackets with `run-started` and exactly one terminal on every exit path), `interruptOnAbort(signal)`, `coalesce(window)` (merges consecutive text, reasoning and argument deltas within a window; everything else passes through unchanged). Generic over the event schema. |
| `Encoding` | `toSSE` (`id: seq`, `event: type`, `data: json`), `toNDJSON`, `toWebSocketFrames`. `keepAlive`, `responseHeaders` (incl. `x-effect-uai-ui: 1`), `lastSeq(request)` (`Last-Event-ID` first, then `?after=`). The WebSocket framing reserves binary frames for the v2 side channel. |

**Durable server pieces** (separate entry point, runtime-neutral)

| Module | Content |
|---|---|
| `EventLog` | Service interface keyed by `streamId`: `append`, `readAfter`, `subscribe`. Ships `EventLog.memory`. Storage implementations (Postgres `LISTEN/NOTIFY`, Redis, Durable Streams) live in apps or later packages. |
| `EventLog.record(streamId)` | Stream sink: persist, then notify. |
| `EventLog.serve(streamId, after)` | Subscribe first → replay `seq > after` → live tail → dedupe → end after the terminal. |

**Client** (browser-safe)

| Module | Content |
|---|---|
| `Client` | Sources yielding `Stream<Envelope>`: `sse(request)`, `eventSource(url)`, `ndjson(request)`, `webSocket(url)`. `resumable(connect, schedule, { resumeOnVisible? })` reconnects from the last seq, dedupes, completes on the terminal; `resumeOnVisible` re-attaches when `visibilitychange` finds a dead stream (mobile Safari). |
| `Transport` | Plain values. `direct({ request })`, `durable({ submit, events, stop?, resolve? })`, `local((input) => Stream<RunEvent>)`, `fromStream((input) => Stream<Envelope>)` (RPC and server functions). Missing capabilities are absent in the type, so the UI knows whether stop or resume exists. |
| `RunView` | The client's view of one server run, exported as a fold pair (`initial`, `step`) plus pure selectors (`text`, `isBusy`, `toolCalls`, `objects(view, name, Schema)`). Plain data, no actions: `{ streamId, runId, lastSeq, status: idle \| submitted \| streaming \| completed \| interrupted \| failed \| stopped, blocks, toolCalls, objects, interrupts, usage, data, live, metadata, error? }`. Blocks: `text`, `reasoning`, `tool` (`input-streaming → ready → awaiting-approval → running → done \| failed \| denied \| cancelled`), `object`, `data`, `image`, `citation`. Idempotent on `seq`. Generic over app payload schemas. Required. |
| `Thread` | Optional reference fold, see above. |

**Atoms** (`@effect-uai/ui/Atoms`, framework-neutral)

- `Atoms.make({ transport, initial, step, busy })` returns `{ state, submit, stop?, resolve? }` (`state` an atom, the rest `Atom.fn`s). `Atoms.thread({ transport })` is the `Thread` preset. `runAtom = Atom.family(streamId => …)` folds one durable run.
- No queueing, persistence or paging options; those are separate atoms the app composes.
- React: `useAtomValue` / `useAtomSet` from `@effect/atom-react`. Vue and Solid: official bindings. Svelte and vanilla: `registry.subscribe`. Each gets a docs snippet.

### No `@effect-uai/react` in v1

Both planned hooks moved into the neutral layer (`Thread.withPersisted`,
`Client.resumable({ resumeOnVisible })`). What remains is `useAtomValue`, and
a package that saves one line per call site is the duplicated API surface the
"no shortcuts over generic helpers" rule rejects. Revisit if React-specific
logic appears: SSR/RSC hydration (`effect/reactivity` has `Hydration`) or an
assistant-ui `ExternalStoreRuntime` adapter.

## Phase 2: live sessions (voice, camera, media)

The voice recipes are the strongest real case for multi-run streams, so they
come before generative UI.

### What the recipes do today

All three hand-roll one WebSocket with a JSON `StatusEvent` union in text
frames and raw PCM in binary frames, and imperative DOM clients with
module-level `let` state:

- **`voice-loop`** (STT → LLM → TTS): browser sends untagged mic PCM (s16le
  16 kHz, 50 ms frames); server sends `user-partial` / `user-final` /
  `assistant-thinking` / `assistant-delta` / `assistant-done` /
  `assistant-cancelled` / `error` plus TTS PCM. Barge-in is server-side (a
  stop-word watcher interrupts the turn); the server paces audio with
  `Effect.sleep(chunkDuration)` to guess playback position.
- **`realtime-voice-agent`** (speech-to-speech): inbound frames tagged with a
  1-byte prefix (`0x00` audio, `0x01` typed text, `0x02` playback position).
  Server sends `user-transcript { text, final }`, `assistant-started` /
  `delta` / `done`, `speech-started`, `interrupted`, `tool-call`, `tool-done`,
  `tool-cancelled`, `session-ending`. On barge-in the client reports
  `playedMs`, the server turns it into `RealtimeInput.PlaybackPosition` so the
  model truncates what the user never heard.
- **`camera-assistant`**: the realtime shape plus JPEG frames, but tag `0x02`
  means video here and playback position in the realtime recipe; its `played`
  reports are generated and never consumed.

No events carry ids, so the client cannot correlate. User-partial semantics
differ (voice-loop sends snapshots, realtime sends deltas). Usage, VAD
`speech-stopped` and resumption handles are dropped.

Real voice apps built on the pipeline pattern (STT → LLM → TTS) add three
requirements the recipes don't show:

- **Concurrent side runs.** Besides the main voice reply, each user turn forks
  background agents (e.g. a structured-output reviewer scoring the user's
  turn, a planner preparing the next reply, a detector raising domain events).
  Their results stream into the same session while the main reply plays.
  Hence `runId` on every run-scoped envelope and a `name` on `run-started`.
- **Playback-synced text.** Assistant text should appear as it is heard, not
  as it is generated. Today clients estimate this from played samples and an
  average speaking rate. TTS providers return character or word alignment;
  forwarding it fixes the estimate.
- **Local-only analysis.** The mic feeds the upload and, at the same time, a
  browser-side analysis loop (loudness, pitch at animation-frame rate) that
  never reaches the server. The mic source must be shareable between an
  upload stream and local analysis frames.

They also repeat the recipes' server-side workarounds: pacing TTS sends with
`Effect.sleep(chunkDuration)` so the reply fiber lives as long as playback
(only so barge-in can still interrupt it), and regrouping LLM deltas into
speakable clause-sized chunks before streaming TTS.

Duplication: `mic-worklet.ts` and `worklet.d.ts` are byte-identical in all
three, the playback worklet nearly so, and ~200-250 lines of each `main.ts`
(audio graph setup, WebSocket handling, block rendering, follow-scroll,
teardown) are shared. Each `app.ts` repeats ~40-65 lines of
queue/`upgradeChannel` WebSocket plumbing; realtime and camera repeat ~75
lines of tool fork/cancel.

### What changes in the protocol (reserved now, built in v2)

- **Multi-run streams and session-scoped events.** A live connection is one
  stream with many runs (one per response) plus events that belong to no run.
  The envelope already supports this; v2 adds session events:
  `input-transcript { inputId, text, final, mode: "snapshot" \| "delta" }`,
  `vad { state: "speech-started" \| "speech-stopped" }`,
  `audio-started { runId, format }` / `audio-ended { runId }`.
- **Barge-in** is `run-stopped { by: "barge-in" }` (reserved in v1), plus
  `tool-cancelled` for model-cancelled tool calls (in v1).
- **Upstream playback state** `playback-position { runId, playedMs }` and
  `playback-ended { runId }`, so the server can truncate and knows when a
  reply is really over. This replaces server-side pacing by sleep: the reply
  stays interruptible until the client reports it finished.
- **Audio alignment** `audio-alignment { runId, offsetMs, chars | words with
  start/end ms }` from TTS providers that return it. The fold combines it
  with played position into `heardText` per run, so subtitles never run ahead
  of the audio; without alignment it falls back to a rate estimate.
- **Concurrent runs** in one live stream: the main reply plus named side runs
  (structured reviews, planners), each bracketed and terminated on its own.
- **A binary side channel** for audio and video, never in the JSON event log
  (base64 bloat, no value in replay). WebSocket binary frames
  `[u8 kind][u16 channel][payload]` with a registered kind table (`audio-in`,
  `audio-out`, `video-frame`, `playback-position`), unsequenced, referenced
  from JSON events by `runId`. Replaces the per-recipe tag bytes and their
  collision.
- **Upstream media inputs.** Continuous mic audio, video frames and typed text
  are client-to-server streams on the same connection, alongside `Input`.
- Latency metrics (time to first audio, STT lag) ride on `live`.

### What the library adds in v2

- **`VoiceSession` fold** (optional, like `Thread`): `RunView` per run
  (main and side runs by `name`), user turns (partial/final), `vad`,
  `speaking: runId | null`, `heardMs` and `heardText` per run, `live`. Replaces every `currentUser` / `currentAssistant` /
  `setStatus` switch in the recipes.
- **Projection** from `RealtimeEvent` and `TranscriptEvent` onto the protocol,
  plus the tool fork/cancel helper the realtime recipes duplicate.
- **Server** `Encoding.toWebSocketDuplex`: replaces the queue/`upgradeChannel`
  boilerplate in each `app.ts`.
- **Browser media helpers** (`@effect-uai/ui/Media`, Effect Streams and Sinks,
  worklets shipped as package assets): `micStream({ sampleRate,
  echoCancellation, autoGainControl }): Stream<Uint8Array>` (owns the worklet,
  the muted `<audio>` anchor workaround and teardown via scope), shareable
  with `micFrames({ fftSize })` for local analysis (an `AnalyserNode` tap as a
  `Stream<Float32Array>` at frame rate; pitch and loudness detectors stay app
  code), `playbackSink({
  sampleRate })` with `clear`, `reset` and `played: Stream<ms>`,
  `cameraFrames({ fps, maxSide, gate })`, PCM converters, and
  `Transport.live(url)` for the duplex connection.
- **Core gaps surfaced here (server side, `@effect-uai/core`, not UI):** a
  speakable-chunk operator for streaming TTS input (regroup LLM deltas at
  clause or word boundaries so word fragments don't cause audible cuts), and
  alignment events on `SpeechSynthesizer` streams where providers supply them.
- **Stays recipe code:** stop-word and burst-settling policy, phonetic
  rewrites, the camera loudness gate and frame budget, provider presets, tool
  sets, markup.
- **Expected shrink:** voice-loop client ~460 → ~100 lines, realtime ~550 →
  ~100, camera ~640 → ~150; each `app.ts` ~60 lines shorter; realtime/camera
  `recipe.ts` ~60 lines shorter.

### Media output beyond audio

Images already have a block. Music, video and generated files follow the same
rule as live audio: bytes don't go in the event log. A `media { id, kind,
mimeType, ref }` block points at a URL or asset id the app serves (core's
`Job` covers long-running generation); progress rides on `tool-progress` or
`live`. Streaming playback of generated audio (TTS, music previews) uses the
binary side channel. Phase 2 for audio, phase 3 for video and files.

## Phase 3+: extension points

### Sessions with a state channel (generative UI)

A long-lived stream where the model maintains app state rather than (or
besides) messages. The cuttlekit prototype (`~/code/cuttlekit/toolkit`,
experimental, AI SDK + Effect v3) is the only reference so far; treat its
specifics with care. Shape: `POST` an action (202), a per-session processor
batches queued actions into one generation, the model emits validated UI
patches, `GET ?offset=` serves bootstrap or replay plus live tail.

- **Reserved now:** per-stream seq with runs bracketed inside, input ids
  listed by `run-started`, generic payloads; v2 brings multi-run sessions.
- **Adds:** `state-snapshot { value }` and `state-delta { patch }` (JSON
  Patch, the AG-UI split; the object events already exercise the same patch
  machinery), `EventLog.serve` options `endOn: "never"` and a snapshot
  bootstrap for cold joins, an `action { name, data, source? }` input, a
  `generative-ui` recipe with queue-batch input policy.
- **Stays app code:** patch op sets and selectors, component templates,
  `data-action` DOM conventions, validation against a server VDOM.

### MCP Apps (tool-provided UI)

The MCP Apps extension (`io.modelcontextprotocol/ui`, extension spec
2026-01-26, from SEP-1865) lets an MCP tool declare `_meta.ui.resourceUri`
pointing at a `ui://` resource (`text/html;profile=mcp-app`). The host
renders it in a sandboxed iframe and speaks `ui/*` JSON-RPC over
`postMessage`; the app can call server tools (including app-only tools with
`_meta.ui.visibility: ["app"]`), subject to host approval. ChatGPT supports
it.

Not part of this plan. MCP work (client-side MCP Apps host, MCP server
support for effect-uai agents and tools, and where the browser bridge lives)
is tracked in `plans/backlog.md` under MCP and gets its own plan. This plan
only reserves the `ui` field on `tool-call-ready` / `tool-result` (a
`{ server, resourceUri }` reference, never the HTML), so a later MCP Apps
host can render tool UIs without a protocol change.

### WebMCP

W3C Web Machine Learning CG draft (`document.modelContext`, Chrome origin
trial): a page registers tools for an in-browser agent. Not MCP on the wire.
Possible follow-ups: register app actions as WebMCP tools, or a `Toolkit`
adapter for a browser-side agent. Nothing reserved beyond typed, identified
inputs.

### Other frameworks

- **FoldKit**: a recipe, no package expected. `RunView` / `Thread` as a
  Submodel, `step` inside `update`, `submit` / `stop` / `resolve` as
  Commands, `Client.resumable(...)` as a Subscription keyed on `{ streamId }`.
- **Vue / Solid / Svelte / vanilla**: docs over the atoms.
- **`@effect-uai/tanstack-ai`** (AG-UI projection + decoder) and a `RunEvent`
  input for `@effect-uai/ai-sdk`: additive projections.

## Performance

Some providers send one text delta per token, so a run can produce hundreds
of events per second. Each concern stays where it belongs:

- **Server: `Run.coalesce(window)`**, piped like the metrics helpers. Fewer
  frames on the wire and fewer rows in a durable log. Recommended in durable
  mode; opt-in in direct mode. Neither the atom nor `RunView` knows about it.
- **Fold: structural sharing.** A delta replaces only the block it touches;
  every other block keeps its identity, so finished blocks can be memoized by
  any renderer and selectors stay cheap.
- **Client: just a stream.** Transports yield plain `Stream`s, so a client
  that receives uncoalesced events (e.g. `Transport.local` with a
  token-per-event model) pipes `Stream.throttle` before the scan. No extra API.
- **Rendering: per-block derived atoms** (`Atoms.block(view, blockId)`) for
  long transcripts, so only the streaming block's subscriber updates.
  Markdown re-parsing cost belongs to the renderer and benefits from the
  stable block ids.

Test: a benchmark folding 500 deltas per second asserts fold time stays
negligible and that `coalesce` bounds the frame count.

## Requirements and constraints

- Effect v4 (peer `>=4.0.1 <5`; `effect/reactivity` and `effect/JsonPatch` are stable since 4.0), same conventions as the other packages: tsdown, `exports` per module, changesets, debut at the current fixed-group version.
- **No `ai` / `@ai-sdk/*` / `@tanstack/ai` dependency.**
- Client, atom and media modules are browser-safe; durable server modules sit behind their own entry point.
- Generic: no app concepts (titles, languages, chat lists). Apps add them through `data` / `live` events, input `metadata`, request builders and their own folds.

## Pitfalls designed against

Observed in real durable-stream code (cuttlekit's processor) and the voice recipes:

1. Ignoring `Last-Event-ID` → auto-reconnect replays from the stale URL offset. `lastSeq(request)` reads the header first; `step` dedupes anyway.
2. Offsets reset after cleanup → clients filter out new events. Seq is per stream and a stream id is never reused.
3. Publish before persist → a subscriber misses an event. `EventLog.record` persists first; `serve` subscribes first.
4. No terminal on failure → spinner forever. `withTerminal` covers every exit.
5. Generation tied to the request scope dies with the connection. Shown in the `durable-chat` recipe; not a library runner.
6. Stop inferred from disconnect (durable mode). Stop is a transport capability.
7. Events without ids (voice recipes) → the client cannot correlate responses, tools and audio. Every run, tool call, object and media chunk carries an id.
8. Ad hoc binary tags (`0x02` meaning two things) → one registered kind table.

## Tests

- `RunView.step` and `Thread.step` (via `Stream.runFold`): table of envelope sequences → expected state, including duplicate and out-of-order seq, replay from any point, multi-step tool loops, `step-reset`, interrupts, `live` overwrite, input reconciliation, `submitted` → `streaming`, and object streams (partial patches, done replaces partial, failed, lists by `name`).
- `StructuredFormat.decodePartial`: chunk boundaries inside strings, numbers and escapes; deep partials; validation only on the final.
- `Projection`: conformance against `MockProvider` scripted turns (text, reasoning, tool loop with progress, approval, refusal, citations, objects in all three modes), mirroring `packages/compat/ai-sdk/src/conformance.test.ts`.
- `withTerminal`: completed, interrupted, failed and approval-stop each yield exactly one terminal. `interruptOnAbort` with an aborted and a later-aborted signal.
- `EventLog.serve` with `EventLog.memory`: subscribe mid-run, reconnect with `after`, duplicate notify, terminal during replay, two concurrent readers.
- `Client.resumable`: drop mid-run, resume without duplicates; `sse` against a byte stream; `eventSource` with a fake `EventSource`.
- `Transport.local` drives the fold tests end to end without a network.
- `outputSchema`: a tool returning malformed output yields an `output_encoding` failure; `Date` / `Uint8Array` outputs encode through the schema; tools without it are unchanged. Type-level tests (`expectTypeOf`) that `run` must return `O["Type"]`.
- `UiContract`: tool-block narrowing by `name` types `input` / `output` (`expectTypeOf`); unknown names fall back to untyped blocks; settled payloads decode (e.g. ISO string → `Date`), deltas are not decoded.
- Atoms through `AtomRegistry.make()` with no framework.

## Deliverables (v1)

1. `@effect-uai/ui` with README and a docs section "Agentic UI" (protocol, modes, lifecycle, objects, `Thread` vs custom folds, atoms, framework snippets).
2. Core prerequisites in `@effect-uai/core`: `StructuredFormat.decodePartial` and the optional `outputSchema` on `Tool.make` (with output validation in `Toolkit`).
3. `examples/react-next`: the `ai-sdk-next` app rebuilt on `@effect-uai/ui` + `@effect/atom-react`, with a second route for the durable variant (`EventLog.memory`, resume after a refresh, explicit stop) behind the same UI with only the transport swapped. Side by side with `ai-sdk-next`, it is the basis for the "coming from AI SDK" page.
4. Recipes, each self-contained: `direct-chat`, `durable-chat`, tool approval over the durable transport, `streaming-objects` (partial object and object list rendered live), and "tool result → component" (the mainstream generative-UI pattern: map tool names to components).
5. `docs/coming-from`: comparison with AI SDK `useChat` / `useObject` and TanStack AI `ChatClient`.

## Out of scope for v1

- Everything in phase 2 and 3+.
- Storage-backed `EventLog` implementations; apps own them first, maybe later `@effect-uai/ui-sql`.
- UI components.
- Client-side tool execution: the `run-interrupted` shape leaves room.

## Decisions

Resolved (2026-11-06):

- **Package names**: `@effect-uai/ui`. Central modules `RunEvent`, `RunView`, optional `Thread`.
- **Plan file**: `plans/ui.md` (was `plans/react-chat.md`).
- **v1 scope**: agentic chat, direct and durable, plus structured-object streaming. Voice and media are phase 2; generative UI, MCP Apps and WebMCP are phase 3+.
- **No React package in v1**: `@effect/atom-react` directly.
- **Modes**: two axes (where generation lives × wire). Long-poll and RPC are considered, plug into `Transport.fromStream`, and ship later.
- **Objects**: one concept; a single object is an object stream of length one.
- **Naming**: `RunView` (client view of a run, was `RunState`), folds as `initial` + `step` pairs (not "reducer"), `thread.active` for the streaming run, `Run.*` for server-side stream helpers.
- **Performance**: server-side `Run.coalesce`, structural sharing in `step`, per-block derived atoms; no batching inside atoms or `RunView`.
- **Shared types**: an optional `UiContract` built from Schemas; tool output typing via an optional `outputSchema` on `Tool.make` (option b), which also validates tool output server-side. Unknown names stay untyped (not rejected); the client decodes settled payloads only; everything works without a contract.

- **Protocol**: our own Schema union, event names close to AG-UI; an AG-UI projection is a later additive package (like `@effect-uai/ai-sdk`). AG-UI lacks seq/resume, input ids, typed tool results and object streaming.
- **Run machinery location**: `sequence`, `withTerminal`, `interruptOnAbort`, `coalesce`, `EventLog`, `Client.resumable` start in `@effect-uai/ui`; move to `@effect-uai/core` once a non-UI consumer needs them.
- **Reasoning**: default `reasoning: "signal"` (only `reasoning-started`), switchable per projection: `"summary"` forwards `ReasoningDelta { kind: "summary" }` (OpenAI Responses summaries, Anthropic summarized thinking, Gemini thought summaries), `"full"` also forwards raw traces (open models). Provider behavior to be confirmed during implementation.
- **Object deltas**: JSON Patch (RFC 6902, as AG-UI's `STATE_DELTA`) via `effect/JsonPatch`, no extra library; snapshot fallback mid-stream; `object-done` always carries the full value.
- **Media utilities**: pure, dependency-free audio format utilities (PCM s16 ↔ f32, resampling, chunk duration, WAV header) go in `@effect-uai/core` next to `domain/Audio.ts`; browser capture and playback (worklets, camera, analyser tap) go in `@effect-uai/ui/Media`. A separate `@effect-uai/media` package only when something needs a codec dependency (OGG/Opus or MP3 transcoding for messenger voice notes, via ffmpeg or a wasm codec).
- **MCP**: out of this plan. MCP Apps (host side), MCP server support and the bridge placement are tracked in `plans/backlog.md`; this plan only reserves the `ui` reference field.

Open: none for v1. Phase 2 confirms provider reasoning behavior and the media utilities' exact API.
