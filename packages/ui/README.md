# @effect-uai/ui

Agentic UI primitives for effect-uai: state and streams, not components.

A server projects its agent loop onto a small, resumable wire protocol; a
client folds the protocol into plain data that any framework can render.

## Modules

Server:

- `Projection`: turns an effect-uai loop into `RunEvent`s (`toRunEvents()`).
- `Run`: `withTerminal` (exactly one terminal per run, `stopWhen` to stop),
  `sequence` (per-stream `seq`), `coalesce` (merge deltas).
- `Encoding`: SSE framing (`toSSE`, `fromSSE`), `responseHeaders`,
  `lastEventId(headers)` for reconnects.

Wire:

- `RunEvent`: the event schemas, the `Envelope { streamId, seq, runId?, event }`
  every frame is wrapped in, and branded `StreamId` / `RunId` / `InputId`.
  `RunEvent.EnvelopeJson` is the JSON codec.
- `Input`: what a client sends. A preset (`Input.submit(text | messages, { data })`,
  `Input.resolve(decisions)`) with core user messages and typed app `data` via
  `Input.make(DataSchema)`; any schema with an `id` works instead.

Client:

- `RunView`, `Thread`: folds (`initial` + `step`) from envelopes to plain data:
  one run, or a chat (messages, the active run, pending inputs).
- `Client`: `sse`, `ndjson`, and `resumable` (reconnect from the last `seq`).
- `Transport`: per run (`direct`, `durable`, `local`) or per session
  (`session`: one stream per chat, the server queues messages).
- `Atoms`: framework-neutral state on `effect/reactivity`: `make` / `thread`
  for per-run transports, `session` / `chat` for sessions. React reads them
  with `@effect/atom-react`, plain JS with `AtomRegistry.subscribe`.

See the `durable-chat` recipe for a complete server and page.

## Install

```sh
pnpm add @effect-uai/ui
```

ESM-only. Requires `effect@>=4.0.1` and `@effect-uai/core` as peers.
