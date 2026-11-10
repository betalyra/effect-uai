# @effect-uai/ui

Agentic UI primitives for effect-uai: state and streams, not components.

Your agent runs on the server; your user watches it in a browser. This
package is the part in between: the server projects its loop onto a small,
resumable wire protocol, and the client folds that protocol into plain data
any framework can render. Every piece is a small function you can read,
replace, or skip.

## Modules

Server:

- `Projection`: turns an effect-uai loop into `RunEvent`s
  (`toRunEvents({ contract })`; the contract's tool schemas encode tool values).
- `Run`: one operator per job. `start` (`run-started` first), `complete`
  (one terminal last), `stopWhen` (stop on a signal), `failed` (an error as
  `run-failed`), `sequence` (per-stream `seq`), `coalesce` (merge deltas).
- `SseEncoding`: envelopes as Server-Sent Events on Effect's `Sse`
  (`encode`, `decode`, `responseHeaders`, `lastEventId` for reconnects).

Wire:

- `RunEvent`: the event schemas, the `Envelope { streamId, seq, runId?, event }`
  every frame is wrapped in, and branded `StreamId` / `RunId` / `InputId`.
- `Input`: what a client sends. A preset (`Input.submit(text)`,
  `Input.resolve(decisions)`), with typed app `data` via `Input.make(DataSchema)`;
  any schema with an `id` works instead.
- `UiContract`: optional types shared by server and client, from Schemas
  only. The wire stays JSON; the client decodes each envelope once, so the
  state holds typed values (a `Date` is a `Date`).

```ts
// shared: Schemas only, safe in the browser
const ChatUi = UiContract.make({ tools: [GetWeather] })

// client: the state is typed by the contract
const chat = Atoms.thread({ contract: ChatUi, runtime, transport, busy: "block" })
for (const b of thread.active?.blocks ?? [])
  if (b.type === "tool" && b.name === "get_weather" && b.outcome?._tag === "Success")
    b.outcome.value.observedAt // Date
```

Client:

- `RunView`, `Thread`: folds (`initial` + `step`) from envelopes to plain
  data: one run, or a chat (messages, the active run, pending inputs).
- `Client`: `sse`, `ndjson`, and `resumable` (reconnect from the last `seq`).
- `Transport`: per run (`direct`, `durable`, `local`) or per session
  (`session`: one stream per chat, the server queues messages).
- `Atoms`: state on `effect/reactivity`. `make` / `thread` for per-run
  transports, `session` / `sessionThread` for sessions. React reads them with
  `@effect/atom-react`, plain JS with `AtomRegistry.subscribe`.

The `direct-chat` and `durable-chat` recipes are a server and a page each;
`examples/tanstack-start-chat` and `examples/foldkit-chat` are framework apps
with typed tools.

## Install

```sh
pnpm add @effect-uai/ui
```

ESM-only. Requires `effect@>=4.0.1` and `@effect-uai/core` as peers.
