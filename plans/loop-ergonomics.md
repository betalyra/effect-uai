# Loop Ergonomics — Extract Primitives Without Hiding the Loop

## Context

The experiment ([experiments/responses.ts](../experiments/responses.ts)) and three of four
conversation tests ([test/conversation.test.ts](../test/conversation.test.ts)) repeat the
same `Stream.paginate` body. Goal: extract _projection_ helpers so beginners
have less ceremony, while keeping the loop, the tool-execution decision, and
the history mutation explicit.

Non-goal: a Vercel-style `streamText` that hides everything.

## Repeated boilerplate (audit)

The same ~10-line block appears in 4 call sites (experiment + 3 tests):

```ts
Effect.flatMap((t) => {
  const history = [...state.history, ...t.items]
  const cursor = { history, turn: t, index: state.index }
  const calls = functionCalls(t)
  if (calls.length === 0) {
    return Effect.succeed([[cursor], Option.none<State>()] as const)
  }
  return Toolkit.executeAll(toolkit, calls).pipe(
    Effect.map(
      (outputs) =>
        [
          [cursor],
          Option.some<State>({
            history: [...history, ...outputs],
            index: state.index + 1,
          }),
        ] as const,
    ),
  )
})
```

Sub-patterns inside:

1. `[...history, ...turn.items]` + cursor struct construction.
2. `[[cursor], Option.some/none] as const` — `Stream.paginate`'s tuple shape
   leaking into user code.
3. `Toolkit.executeAll → [...history, ...outputs]` — the default
   tool-execution step.

The experiment additionally hand-rolls
`streamTurn → Stream.runFold → check turn !== undefined`, duplicating
[src/LanguageModel.ts:53-66](../src/LanguageModel.ts#L53-L66) (`turn`) — but
the inline form adds `Stream.tap` for delta observability, which `turn` can't.

## Phase 1 — Streaming-aware turn collector

**File:** [src/LanguageModel.ts](../src/LanguageModel.ts)

Add an `onDelta` option to `turn` so users get streaming observability without
giving up the assembled `Turn`:

```ts
turn(history, options, {
  onDelta?: (d: TurnDelta) => Effect.Effect<void, never, R>
})
```

Implementation: `streamTurn(...).pipe(Stream.tap(onDelta), runFold to Turn)`.

**Impact:** -8 lines in the experiment. No magic — the body is still
`streamTurn + tap + fold`.

## Phase 2 — Safe tool execution

**File:** [src/Toolkit.ts](../src/Toolkit.ts)

Add `executeAllSafe(toolkit, calls, onError)` that runs `executeOne` per call,
catches `ToolError`, hands it to `onError`, which returns a
`function_call_output` (typically with a structured error payload the model
can read).

```ts
executeAllSafe<Tools>(
  toolkit: Toolkit<Tools>,
  calls: ReadonlyArray<FunctionCall>,
  onError: (err: ToolError, call: FunctionCall) => FunctionCallOutput,
  options?: { concurrency?: number | "unbounded" }
): Effect.Effect<ReadonlyArray<FunctionCallOutput>, never, ToolsR<Tools>>
```

**Impact:** the repair test ([test/conversation.test.ts:361-375](../test/conversation.test.ts#L361-L375))
collapses from 15 lines to a one-liner. This is the bedrock for every
real-world provider where models routinely emit malformed args.

## Phase 3 — Streaming-aware Conversation.unfold (decide after Phase 1+2)

**File:** [src/Conversation.ts](../src/Conversation.ts)

The existing `Conversation.unfold` uses non-streaming `runTurn`. Switch it to
`streamTurn` + `onDelta` so it can replace the manual `Stream.paginate` in
the experiment.

User step shape becomes:

```ts
type Step<E, R> = (cursor: Cursor) => Effect.Effect<
  ReadonlyArray<Item> | undefined, // next history, or undefined to stop
  E,
  R
>
```

The loop wires `Step` into `Stream.paginate` internally. User code drops from
~12 lines to ~5.

**Trade-off:** opinionated — replaces explicit `Stream.paginate` with a named
helper. Keep at least one test using raw `Stream.paginate` as a "this is what
actually happens" reference, so the explicitness claim stays honest.

**Decision:** evaluate after Phase 1+2 land — measure how much remaining
ceremony there is in user code before committing to this.

## Out of scope (keep explicit)

- The decision to execute tools at all. Branching on
  `functionCalls(turn).length` is the user's call — never hide it.
- History extension. `[...history, ...outputs]` is one line and lets users
  splice in summaries, redactions, prompt-cache markers.
- `Stream.paginate` itself — only its tuple ceremony.

## Order of operations

1. Phase 1 (`turn` with `onDelta`) — touches [src/LanguageModel.ts](../src/LanguageModel.ts), update experiment.
2. Phase 2 (`executeAllSafe`) — touches [src/Toolkit.ts](../src/Toolkit.ts), update repair test.
3. Re-read the experiment + tests, decide on Phase 3.

---

# Phase 4 — Delta-level conversation stream (real-time forwarding)

## Problem

Today the outer loop is `Stream<Cursor>` — one event *per turn*. Inside each
turn, deltas are streamed from OpenAI but only used for `Stream.tap` logging
or folded into a `Turn`. They never escape the iteration. For a real backend
serving a frontend, that's wrong: text deltas, reasoning summaries, and tool
call arguments need to flow through as they arrive. Vercel AI SDK does this
end-to-end (text, tool starts, tool *results*); we currently can't.

What a real session should look like over the wire:

```
text_delta, text_delta, ...,
tool_call_start { call_id, name },
tool_call_args_delta, ...,
turn_complete { turn },           ← LM's first turn finishes
tool_result { call_id, output },  ← we ran the tool — frontend wants to render this
text_delta, text_delta, ...,
turn_complete { turn },           ← LM's second turn (no tool calls)
                                    conversation ends
```

## Public event type

Extend `TurnDelta` with conversation-level events. The discriminator stays
`type`, the existing TurnDelta variants pass through unchanged.

```ts
// in src/Conversation.ts (or a new src/ConversationEvent.ts)
export type ConversationEvent =
  | TurnDelta                                                // text/reasoning/tool_call_*/turn_complete
  | { readonly type: "tool_result"; readonly output: FunctionCallOutput }
  | { readonly type: "tool_failed"; readonly call_id: string; readonly error: ToolError }
```

`tool_failed` is emitted *in addition to* `tool_result` when `defaultRepair`
(or the user's `onError`) handled a `ToolError` — so the frontend can show a
"tool failed, retrying" banner while still seeing the repair output that gets
fed back to the model.

## Construction — recursive `Stream.concat` with `Ref` capture

The loop body returns a `Stream<ConversationEvent>` per turn instead of a
single Cursor. The continuation depends on the assembled `Turn`, which is
captured side-channel via a `Ref` while deltas pass through unmodified.

```ts
const conversation = (state: State): Stream.Stream<ConversationEvent, AiError, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const turnRef = yield* Ref.make(Option.none<Turn>())

      // Forward every delta downstream; capture the Turn when we see it.
      const turnDeltas = oai.streamTurn(state.history, options).pipe(
        Stream.tap((d) =>
          d.type === "turn_complete"
            ? Ref.set(turnRef, Option.some(d.turn))
            : Effect.void,
        ),
      )

      // After the inner stream ends, decide what comes next.
      const continuation = Stream.unwrap(
        Ref.get(turnRef).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new AiError({ message: "Stream ended without turn_complete" })),
              onSome: (turn) => Effect.succeed(continueWith(state, turn)),
            }),
          ),
        ),
      )

      return Stream.concat(turnDeltas, continuation)
    }),
  )

const continueWith = (state: State, turn: Turn): Stream.Stream<ConversationEvent, ...> => {
  const cursor = Conversation.cursor(state, turn)
  const calls = Turn.functionCalls(turn)
  if (calls.length === 0) return Stream.empty // turn_complete already emitted

  return Stream.unwrap(
    Toolkit.executeAllSafe(toolkit, calls).pipe(
      Effect.map((outputs) => {
        const toolEvents = outputs.map(
          (output): ConversationEvent => ({ type: "tool_result", output }),
        )
        const next = {
          ...state,
          history: [...cursor.history, ...outputs],
          index: state.index + 1,
        }
        return Stream.concat(Stream.fromIterable(toolEvents), conversation(next))
      }),
    ),
  )
}
```

`Stream.concat(a, b)` is lazy in `b` — `b` is only evaluated *after* `a`
completes — so the `Ref.get` reliably sees the captured Turn.

## How this changes the experiment

The user's program becomes a `Stream.tap`-and-render loop over events,
not a `Stream.runCollect` of cursors:

```ts
yield* conversation(initial).pipe(
  Stream.tap((event) =>
    Match.value(event).pipe(
      Match.discriminator("type")("text_delta", ({ text }) => writeToFrontend(text)),
      Match.discriminator("type")("tool_result", ({ output }) => sendToolResult(output)),
      // ... etc
      Match.orElse(() => Effect.void),
    ),
  ),
  Stream.runDrain,
)
```

The current `Cursor` stream is *derivable* from this event stream via
`Stream.scan` (accumulate state on `turn_complete` + `tool_result`), so Phase
4 strictly subsumes Phase 3 — Phase 3's helpers (`Conversation.cursor`,
`stop`, `advance`) become useful only if you opt into the simpler per-turn
pagination model.

## Public API surface

Two helpers, similar shape to today:

```ts
// Drives the recursive stream; user provides a streamTurn fn (so provider-
// typed options like `reasoning.effort` work) plus the toolkit and onError.
Conversation.events(initial, {
  streamTurn: (history) => oai.streamTurn(history, { tools, reasoning: { effort: "low" } }),
  toolkit,
  onError?: (err, call) => FunctionCallOutput,  // defaults to Toolkit.defaultRepair
}): Stream<ConversationEvent, AiError, R>

// For consumers that still want per-turn cursors:
Conversation.cursors(events): Stream<Cursor, AiError, R>
```

## Open questions

1. **Backpressure vs. provider rate.** If the frontend consumer is slow, the
   inner OpenAI stream should not block (the HTTP response would time out).
   Effect Stream handles this with bounded queues; verify the default is
   sane and document. Worst-case: buffer to disk, but that's far future.
2. **HITL approval gate.** A user wants to inspect tool calls before they
   run. Cleanest: a `beforeTool` hook in the options that returns
   `Effect<"approve" | "deny" | "modify">`. Slots naturally into
   `continueWith`. Out of scope for first cut.
3. **Resumability.** Connection drops; can the consumer reconnect and pick
   up where it left off? Probably needs the durable-event-log work from the
   cuttlekit-use-cases plan. Out of scope for Phase 4.
4. **Tool result streaming.** Vercel AI SDK lets a tool *stream* its result
   (e.g. an LLM-generated summary tool). Our `Tool.run` returns
   `Effect<output>`. To support streaming results, we'd need
   `Tool.run: Effect<output> | Stream<chunk>`. Big change — separate phase.

## Order

Phase 4 is independent of Phase 3 and can land first. It does NOT require
Phase 3 (`Conversation.unfold`); in fact, building Phase 4 first makes
Phase 3 redundant unless we want a non-streaming convenience wrapper.

Suggested first cut:

1. Define `ConversationEvent` type.
2. Implement `Conversation.events` with the `Ref`-capture pattern above.
3. Add a vitest using `MockProvider` that asserts the event order
   `text_delta..., turn_complete, tool_result, text_delta..., turn_complete`.
4. Update [experiments/responses.ts](../experiments/responses.ts) to consume
   the event stream and log per-event (proves the streaming forwarding works
   end-to-end against real OpenAI).
