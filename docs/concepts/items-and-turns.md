---
title: Items and turns
description: The flat conversation history, the assembled turn, and the event stream that ties them together.
---

One turn is a stream, but a conversation still needs durable data.

Three primitives carry that data: **`Item`** (one entry in history),
**`Turn`** (the assembled result of one model call), and **`TurnEvent`**
(the typed stream you consume while the turn is in flight). The same shapes
are used for every provider. Anything provider-specific lives in that
provider's wire layer, not in your agent harness.

## `Item` - the conversation as a flat list

History is a `ReadonlyArray<Item>`. There is no nested message tree, no
implicit "current turn", no provider-specific role enum. An `Item` is
one of:

```ts
type Item = Message | FunctionCall | FunctionCallOutput | Reasoning
```

- **`Message`** - a `role` (`user` / `assistant` / `system`) plus
  `content: ContentBlock[]`. Content blocks are `input_text`,
  `input_image`, `output_text`, or `refusal`.
- **`FunctionCall`** - the assistant asking for a tool, with `call_id`,
  `name`, and a JSON `arguments` string.
- **`FunctionCallOutput`** - the result you feed back, keyed by
  `call_id`.
- **`Reasoning`** - extended-thinking blocks (Anthropic, OpenAI o-series).
  Surfaced by providers that emit them; a no-op for those that don't.

Build them with the constructors in [`Items`](https://github.com/betalyra/effect-uai/blob/main/packages/core/src/domain/Items.ts):

```ts
import * as Items from "@effect-uai/core/Items"

const history = [
  Items.systemText("You are a helpful assistant."),
  Items.userText("What time is it in Lisbon?"),
]
```

System messages live in the same flat array as user and assistant
turns. Providers split them out at the wire layer (Anthropic's
top-level `system` parameter, Gemini's `systemInstruction`) so you
don't have to. Pass them in the order you want the model to see them.

Discriminated unions get type guards: `Items.isMessage`,
`Items.isFunctionCall`, `Items.isFunctionCallOutput`, `Items.isReasoning`.
Use them with `array.filter` for narrowed slices.

## `Turn` - what one model call returns

A `Turn` is the assembled result of one round-trip:

```ts
type Turn = {
  readonly items: ReadonlyArray<Item> // assistant's outputs (Messages, FunctionCalls, Reasoning)
  readonly usage: Usage // token counts, cache stats
  readonly stop_reason: StopReason // "stop" | "tool_use" | "max_tokens" | "refusal" | "other"
}
```

Helpers project specific item kinds:

```ts
Turn.functionCalls(turn) // FunctionCall[] - the tool requests
Turn.assistantMessages(turn) // Message[] with role: "assistant"
Turn.reasonings(turn) // Reasoning[]
```

`Turn.toStructured(turn, format)` decodes the assembled assistant text
against an Effect Schema and surfaces `RefusalRejected`,
`JsonParseError`, or `StructuredDecodeError` in the failure channel.

## `Turn.appendTurn` - append a completed turn

After a turn, you need the new `history` for the next iteration.
`Turn.appendTurn` appends the model's turn items plus any follow-up items:

```ts
const next = Turn.appendTurn(state, turn, toolOutputs)
// { ...state, history: [...state.history, ...turn.items, ...toolOutputs] }
```

The third argument is usually the tool outputs collected by
`Toolkit.continueWith`, after applying `toFunctionCallOutput` at the wire
boundary:

```ts
import { toFunctionCallOutput } from "@effect-uai/core/Outcome"

return Toolkit.executeAll(allTools, calls).pipe(
  Toolkit.continueWith((results) =>
    Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
  ),
)
```

## `TurnEvent` - the stream

A turn-in-flight is a `Stream.Stream<TurnEvent, AiError, R>`:

```ts
type TurnEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string; kind: "trace" | "summary" }
  | { type: "refusal_delta"; text: string }
  | { type: "tool_call_start"; call_id: string; name: string }
  | { type: "tool_call_args_delta"; call_id: string; delta: string }
  | { type: "usage_update"; usage: Usage }
  | { type: "turn_complete"; turn: Turn }
```

The terminal event is always `turn_complete`, carrying the assembled
`Turn`. Providers normalize their wire formats onto this union, so
`text_delta` from OpenAI Responses, Anthropic, and Gemini are all the
same shape.

Two operators turn a `TurnEvent` stream into something more useful:

```ts
Turn.textDeltas(stream) // Stream<string> - just the text fragments
Lines.lines(stream) // accumulate into newline-delimited lines
```

`textDeltas → lines → decodeJsonLines` is the prompted-JSONL streaming
pattern; see the [streaming structured output recipe](/recipes/streaming-structured-output/).

## What a loop body emits

A loop body's outer stream emits a union of `TurnEvent` (provider
deltas) and `ToolEvent` (executor signals). The `ToolEvent` variants:

```ts
type ToolEvent =
  | { _tag: "ApprovalRequested"; call_id; tool; arguments } // gated, before resolution
  | { _tag: "Intermediate"; call_id; tool; data } // streaming-tool element
  | { _tag: "Output"; result: ToolResult } // terminal per-call result
```

A consumer pattern-matches on `type` (TurnEvent) or `_tag` (ToolEvent)
to drive UI / persistence / observability. See [Tools and toolkits](/concepts/tools/)
for `ToolEvent` and `ToolResult` details.
