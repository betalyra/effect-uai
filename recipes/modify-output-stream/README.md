---
title: Modify the output stream
description: Format the loop's output for the wire by mapping a single function over the stream.
---

The model loop should not know whether the browser wants Server-Sent Events,
your worker wants JSONL, or your test wants raw `TurnEvent`s.

This recipe keeps transport formatting at the edge. Build the same conversation
stream you would use anywhere else, then map the output into the wire format
you need.

**Scenario.** Your agent loop emits `Stream<TurnEvent>`. Serve it as
`text/event-stream` for a web UI and as newline-delimited JSON for another
consumer. No special runner, no alternate conversation type.

## The Design Move

Transport is a projection over the output stream:

- `toSSE` — one `TurnEvent` → one `SSE.Event`, or drop it.
- `toJSONL` — one `TurnEvent` → one JSON line, or drop it.

Both are plain `Result.Result` filters, so they compose with `Stream.filterMap`
directly. They live in the recipe, not core, because they encode product
policy: this version forwards text and completion, and drops everything else.

## The whole thing

```ts
import { Stream } from "effect"
import * as SSE from "@effect-uai/core/SSE"
import { conversation, toJSONL, toSSE } from "./index.js"

// Server-Sent Events on the wire.
const sseBytes = conversation.pipe(Stream.filterMap(toSSE), SSE.toBytes)
//   ^? Stream<Uint8Array, AiError, LanguageModel>

// Newline-delimited JSON lines.
const jsonl = conversation.pipe(Stream.filterMap(toJSONL))
//   ^? Stream<string, AiError, LanguageModel>
```

The recipe also exports `asSSE` and `asJSONL`, the curried form of the same
mapping, which is handy when you want the formatter to read like a named stream
transform:

```ts
const sse = conversation.pipe(asSSE)
const jsonl = conversation.pipe(asJSONL)
```

The recipe's `conversation` is deliberately small: one streamed turn, no tools,
no extra state. In a real app, the same mapping sits after a tool-using loop,
approval flow, retry policy, or long-lived queue-driven chat.

## What gets emitted

| `TurnEvent`                 | SSE                                      | JSONL                                   |
| --------------------------- | ---------------------------------------- | --------------------------------------- |
| `text_delta`                | `event: text\ndata: {"text":"..."}`      | `{"type":"text","text":"..."}`          |
| `turn_complete`             | `event: done\ndata: {"stop_reason",...}` | `{"type":"done","stop_reason":...,...}` |
| reasoning, tool-call deltas | dropped                                  | dropped                                 |

These local `toSSE` and `toJSONL` helpers are intentionally conservative. They
keep text deltas and turn completion events, and drop internals such as
reasoning or tool-call argument deltas.

If your product wants those events on the wire, write your own `filterMap`.
That is the point of the design: the loop emits typed events; the edge decides
which ones become protocol frames.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/modify-output-stream/run.ts
```

The runner prints both wire formats back-to-back so you can copy a
frame straight from the terminal.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/modify-output-stream/index.ts).
