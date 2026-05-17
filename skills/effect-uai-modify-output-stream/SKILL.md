---
name: effect-uai-modify-output-stream
description: Use when the user wants to format the loop's output for a wire transport — Server-Sent Events (browser) or JSONL (CLI pipes, queue payloads). One Stream.filterMap of Turn.toSSE / Turn.toJSONL is the entire transport layer.
license: MIT
---

# effect-uai modify-output-stream

The loop emits a `Stream<TurnEvent>`. To serve it as
`text/event-stream` for a browser or as JSONL for a pipe, map a single
function over the stream. Both helpers ship in
`@effect-uai/core/Turn`.

Reach for this when the user says any of:

- "Stream the agent output as Server-Sent Events"
- "Pipe my agent output as JSONL / NDJSON"
- "Format the model stream for the wire"

## The whole thing

```ts
import { Stream } from "effect"
import * as SSE from "@effect-uai/core/SSE"
import * as Turn from "@effect-uai/core/Turn"

// Server-Sent Events on the wire (Stream<Uint8Array>).
const sseBytes = conversation.pipe(Stream.filterMap(Turn.toSSE), SSE.toBytes)

// Newline-delimited JSON lines (Stream<string>).
const jsonl = conversation.pipe(Stream.filterMap(Turn.toJSONL))
```

## Curried helpers (drop-in `pipe`)

```ts
const sse = conversation.pipe(Turn.asSSE) // == Stream.filterMap(toSSE)
const jsonl = conversation.pipe(Turn.asJSONL) // == Stream.filterMap(toJSONL)
```

## What gets emitted

| `TurnEvent`                 | SSE                                      | JSONL                                   |
| --------------------------- | ---------------------------------------- | --------------------------------------- |
| `TextDelta`                 | `event: text\ndata: {"text":"..."}`      | `{"type":"text","text":"..."}`          |
| `TurnComplete`              | `event: done\ndata: {"stop_reason",...}` | `{"type":"done","stop_reason":...,...}` |
| reasoning, tool-call deltas | dropped                                  | dropped                                 |

If you want reasoning or tool-call argument streams on the wire, write
your own `Stream.filterMap` — `toSSE` / `toJSONL` are deliberately
small. The same pattern composes for tool-using loops: pre-tag your
`ToolEvent`s into a small union and `filterMap` that.

## Browser side (SSE)

```js
const es = new EventSource("/agent")
es.addEventListener("text", (e) => render(JSON.parse(e.data).text))
es.addEventListener("done", (e) => finalize(JSON.parse(e.data)))
```

The `event:` field carries the discriminator so the client can
dispatch by event name.

## What it does not do

- **Reconnection / Last-Event-ID.** Add an `id` field per event before
  `SSE.toBytes` if you need a resumable cursor.
- **Heartbeats.** Long idle periods can have intermediaries close the
  connection; merge a periodic comment frame if you hit this.
- **Tool events.** This recipe only formats `TurnEvent`. Loops that
  emit `ToolEvent` alongside need a custom projection.

## See also

- Recipe source: `recipes/modify-output-stream/`
- For prompted JSONL where the _model_ writes typed objects: `effect-uai-streaming-structured-output`
- The basic loop the transport sits on top of: `effect-uai-basic-usage`
