---
"@effect-uai/ui": minor
---

New package `@effect-uai/ui`: stream an agent's runs to a browser and turn them into state any framework can render.

- `RunEvent`: the wire protocol. Every event a run produces (lifecycle with exactly one terminal, steps, text, refusal and reasoning deltas, citations, images, structured objects, tool calls and results, usage, persisted `data`, transient `live`, and the `input-accepted` echo of a queueing server), wrapped in `Envelope { streamId, seq, runId?, event }`. Branded `StreamId`, `RunId`, `InputId`. `EnvelopeJson` carries image bytes over JSON.
- `Input`: what a client sends, with a client-generated id for optimistic UI. Preset: `submit` (core user messages) and `resolve` (approvals); `Input.make(DataSchema)` adds typed app `data`.
- `UiContract`: types shared by server and client, from Schemas only (`make({ tools, objects, data, live, metadata })`). The wire stays JSON; the client decodes each envelope once, so a tool block narrowed by name has its tool's input and output types. `Envelope`, `RunView` and `Thread` schemas encode typed state back; `data`, `live`, `metadata` are typed server constructors.
- `Projection`: an effect-uai loop as `RunEvent`s (`toRunEvents`). `providerData` never leaves the server.
- `Run`: server operators, one job each: `start`, `complete` (one terminal last), `stopWhen`, `failed`, `sequence` (per-stream `seq`), `coalesce` (merge deltas).
- `SseEncoding`: envelopes as SSE on Effect's `Sse` (`id` = seq, `event` = type), `responseHeaders`, and `lastEventId` for reconnects.
- `RunView`: one run as plain data, folded with `initial` + `step`: ordered blocks in core's shapes, tool calls with status (`error` apart from `output`), objects (`partial` while streaming, `value` once done), `live` values, summed usage. Idempotent on `seq`, so replays are safe.
- `Thread`: an optional chat fold over `RunView` (`Thread.make({ toUser, settle, decodeInput })`, or the preset). Inputs sent during a run wait in `pending` until a `run-started` lists them. A call approved after its run was interrupted updates the card it was asked from (`RunView.applyToolUpdate`; `updateTool` in a custom fold).
- `Client`: `sse`, `ndjson`, and `resumable` (reconnect from the last `seq` on a `Schedule`).
- `Transport`: per run `direct`, `durable`, `local`; per session `session`. `durableHttp` / `sessionHttp` read SSE and reconnect. Any source is a transport: `{ start: (input, state) => stream }`.
- `Atoms`: state on `effect/reactivity`. `make` / `thread` for per-run transports, `session` / `sessionThread` for sessions; `contract` types the state. The runtime provides `SecureRandom` for input ids.
