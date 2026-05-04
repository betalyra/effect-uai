---
title: Modify the output stream
description: Format the loop's output for the wire by mapping a single function over the stream.
---

**Scenario.** Your agent loop emits a `Stream<TurnEvent>`. You want to
serve it as `text/event-stream` for one transport and as JSONL for
another. The whole transport layer is one `Stream.filterMap`.

The two functions ship in `@effect-uai/core/Turn`:

- `Turn.toSSE` — one `TurnEvent` → one `SSE.Event`, or drop it.
- `Turn.toJSONL` — one `TurnEvent` → one JSON line, or drop it.

Both are plain `Result.Result` filters, so they compose with
`Stream.filterMap` directly.

## The whole thing

```ts
import { Stream } from "effect"
import * as SSE from "@effect-uai/core/SSE"
import * as Turn from "@effect-uai/core/Turn"
import { conversation } from "./index.js"

// Server-Sent Events on the wire.
const sseBytes = conversation.pipe(Stream.filterMap(Turn.toSSE), SSE.toBytes)
//   ^? Stream<Uint8Array, AiError, LanguageModel>

// Newline-delimited JSON lines.
const jsonl = conversation.pipe(Stream.filterMap(Turn.toJSONL))
//   ^? Stream<string, AiError, LanguageModel>
```

`Turn.asSSE` and `Turn.asJSONL` are the curried form of the same
`filterMap` — drop them directly into a `pipe`:

```ts
const sse = conversation.pipe(Turn.asSSE)
const jsonl = conversation.pipe(Turn.asJSONL)
```

The recipe's `conversation` is the simplest possible loop — one
streamed turn, no tools, no extra state — so the focus stays on the
transport mapping.

## What gets emitted

| `TurnEvent`                  | SSE                                       | JSONL                                      |
| ---------------------------- | ----------------------------------------- | ------------------------------------------ |
| `text_delta`                 | `event: text\ndata: {"text":"..."}`       | `{"type":"text","text":"..."}`             |
| `turn_complete`              | `event: done\ndata: {"stop_reason",...}`  | `{"type":"done","stop_reason":...,...}`    |
| reasoning, tool-call deltas  | dropped                                   | dropped                                    |

If you want reasoning or tool-call argument streams on the wire, write
your own `Stream.filterMap` — `toSSE` / `toJSONL` are deliberately
small. The same pattern composes for tool-using loops: pre-tag your
`ToolEvent`s into a small union and `filterMap` that.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/modify-output-stream/run.ts
```

The runner prints both wire formats back-to-back so you can copy a
frame straight from the terminal.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/modify-output-stream/index.ts).
