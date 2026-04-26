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
