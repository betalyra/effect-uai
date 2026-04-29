# Plan — use-case audit against the new `loop` primitive

This audit walks through real-world agent scenarios and asks two questions for
each:

1. **Composition** — can it be expressed today with our current `loop`,
   `streamUntilComplete`, `Toolkit.executeAllSafe`, `LanguageModel.streamTurn`,
   `Stream.*`, and `Schedule.*` primitives?
2. **Gaps** — what's missing (a typed error tag, a small helper, a state
   convention, a new combinator)?

The thesis we are validating: **the user owns the loop**. State is a plain
record; `Decision<S>` (`next(state)` / `stop`) controls iteration; the body is
a `Stream`. Every use case below either works through composition or names a
specific small primitive we should add — never a new framework.

The current loop:

```ts
loop<S, A, E, R>(
  initial: S,
  body: (state: S) => Stream<A | Decision<S>, E, R>,
): Stream<A, E, R>
```

Plus `nextAfter(stream, state)` / `stopAfter(stream)` sugar.

---

## 1. Auto-upgrade after N failed tool calls

**Scenario.** Sandbox runs the model's code. Three consecutive failures →
auto-upgrade from `gpt-5-mini` to `gpt-5`.

**Composition.** State threading already gives us this. Carry the model and a
counter on `State`:

```ts
interface State {
  history: Item[]
  model: LanguageModelService
  fallbacks: ReadonlyArray<LanguageModelService>
  consecutiveToolFailures: number
}
```

In the body, after `executeAllSafe(toolkit, calls)`:

```ts
const failures = outputs.filter(isErrorOutput).length
const next = failures > 0 ? Math.min(state.consecutiveToolFailures + failures, /* cap */ 99) : 0
const upgraded =
  next >= 3 && state.fallbacks.length > 0
    ? { model: state.fallbacks[0], fallbacks: state.fallbacks.slice(1), consecutiveToolFailures: 0 }
    : { model: state.model, fallbacks: state.fallbacks, consecutiveToolFailures: next }
return nextAfter(stream, { ...state, ...upgraded, history: [...cursor.history, ...outputs] })
```

**Gaps.**

- `executeAllSafe` returns `FunctionCallOutput`. There is **no typed signal of
  failure** — `defaultRepair` JSON-encodes `{ error: "..." }` into `output`,
  callers parse strings to detect failures. Add a parallel return shape that
  preserves the typed result:
  - `executeAllSafeWithStatus(toolkit, calls): Effect<ReadonlyArray<{ output, status: "ok" | "error" }>, ...>`
  - or extend `FunctionCallOutput` with an optional `status: "ok" | "error"` field that providers can ignore.
- A small helper `withModelEscalation({ threshold, fallbacks })` that wraps the
  decision logic. Just a recipe — not library surface.

**Primitive added: none.** Library helper: typed tool-failure status.

---

## 2. Model-decided upgrade via an `upgrade_model` tool

**Scenario.** Expose a tool the model can call to escalate itself.

**Composition.** Tools have no state access by design — they are
`Effect<Output, Error, R>`. The loop body is what owns state. Pattern:

1. Register an `upgrade_model` tool whose handler returns a sentinel string
   (e.g. `{ accepted: true, target: "gpt-5" }`).
2. In the body, after the turn completes, scan `Turn.functionCalls(turn)` for
   `name === "upgrade_model"` _before_ executing tools. Mutate state.model
   accordingly; emit a `model_upgraded` event; do not feed an output back to
   the model unless desired.

This works today. The body is the right place because upgrading is a
loop-level concern, not a tool-level one.

**Gaps.**

- Recipe needed: "control tools" pattern — tools whose `output` is interpreted
  by the loop body, not the next turn.
- Optional ergonomic: `Toolkit.partition(toolkit, predicate)` to split control
  tools from regular ones, so the body iterates control calls separately.

**Primitive added: none.**

---

## 3. Retry on transient model failure (no partial output)

**Scenario.** `streamTurn` errors before any delta is emitted (TLS, 500,
timeout). Retry with backoff. If retries exhaust, propagate.

**Composition.** Effect already ships this:

```ts
const turn = state.model.streamTurn(state.history, opts).pipe(
  Stream.retry(
    Schedule.exponential("250 millis").pipe(
      Schedule.intersect(Schedule.recurs(3)),
      Schedule.whileInput((e: AiError) => e._tag === "Transient"),
    ),
  ),
)
```

**Gaps.**

- `AiError` is currently a single class. We need it to be a **tagged union**
  so `Schedule.whileInput` / `Stream.catchTag` can distinguish:
  - `RateLimited` (with `retryAfter?: Duration` from headers)
  - `Unavailable` (5xx, network)
  - `Timeout`
  - `ContentFiltered` (terminal — don't retry)
  - `InvalidRequest` (terminal — bug in our code)
  - `AuthFailed` (terminal)
- The provider has to populate `retryAfter` from `retry-after` /
  `anthropic-ratelimit-tokens-reset` headers — unique whitespace per the
  research doc.

**Primitive added:** typed `AiError` variants + provider header extraction.

**Subtlety.** `Stream.retry` re-runs the entire stream constructor. If the
provider already emitted `text_delta` deltas downstream, retrying produces
double-deltas. Two options:

1. **Discipline.** Document: retry is safe only before the first non-error
   pull. The body uses retry around the _entire_ `streamTurn(...)` call but
   only at the top of the body — once `streamUntilComplete` starts forwarding
   deltas, retry is off the table.
2. **New combinator.** `Stream.retryUntilFirstEmit(schedule)` — retry only as
   long as zero values have been emitted. Becomes a no-op the moment any
   value passes through. **Worth adding.** This is the single most common
   "safe-retry" pattern for streams that do real I/O.

**Primitive added:** `Stream.retryUntilFirstEmit` (or similar named).

---

## 4. Multi-model fallback (RateLimit | ContentFilter | Unavailable)

**Scenario.** Try OpenAI; on `RateLimited` or `Unavailable`, fall back to
Anthropic; on `ContentFiltered`, give up.

**Composition.** This is `loop` + typed errors + state-carried fallbacks:

```ts
loop(initial, (state) =>
  streamTurn(state).pipe(
    Stream.catchTags({
      RateLimited: handleFallback,
      Unavailable: handleFallback,
    }),
  ),
)

const handleFallback = (err) =>
  state.fallbacks.length === 0
    ? Stream.fail(err)
    : Stream.fromIterable<Event | Decision<State>>([
        {
          type: "model_fallback",
          from: state.model.id,
          to: state.fallbacks[0].id,
          reason: err._tag,
        },
        next({ ...state, model: state.fallbacks[0], fallbacks: state.fallbacks.slice(1) }),
      ])
```

Note: this restarts the same `state.history` — fine because we never advanced
past the failed turn.

**Gaps.**

- Same as #3: typed `AiError` variants.
- A reusable `withFallback(fallbacks, retryableTags)` helper would package the
  pattern — pure composition, no new primitive.
- For the cleaner "Effect already has `ExecutionPlan`" answer: confirm
  `ExecutionPlan` integrates with our `LanguageModelService`. The fallback
  recipe should show **both** a hand-rolled state-machine version and the
  `ExecutionPlan` version, so users pick.

**Primitive added: none** (relies on #3's typed errors).

---

## 5. Auto memory compaction after X turns or Y tokens

**Scenario.** History grows. After 10 turns OR 50k cumulative tokens, kick off
a compaction step that summarizes history-so-far via a smaller model and
replaces history with `[summary]`.

**Composition.** State threading gives this:

```ts
interface State {
  history: Item[]
  index: number
  cumulativeTokens: number
  // ...
}

// In body, at end of turn:
const cumulativeTokens = state.cumulativeTokens + (turn.usage.totalTokens ?? 0)
if (cumulativeTokens >= MAX_TOKENS || state.index + 1 >= MAX_TURNS) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const summary = yield* compactHistory(cursor.history, summarizerModel)
      const compactionEvent: Event = { type: "compacted", from: cursor.history.length, to: 1 }
      return Stream.concat(
        Stream.fromIterable<Event>([turnComplete, compactionEvent]),
        Stream.fromIterable<Event | Decision<State>>([
          next({ ...state, history: [summary], index: 0, cumulativeTokens: 0 }),
        ]),
      )
    }),
  )
}
```

**Gaps.**

- `Turn.usage` already exists. Need: providers reliably populate it (research
  doc calls out `Usage` cache fields are missing — Phase 1 in
  `cuttlekit-use-cases.md`).
- Recipe `recipes/auto-compaction.md`: shows the trigger predicate, the
  summarizer call, and the `cache_breakpoint` placement so the prefix stays
  cached after compaction.
- Helper `withCompaction({ trigger, compact })` is a thin wrapper — just a
  recipe.

**Primitive added: none.** Phase 1 (Usage with cache tokens) unblocks this.

---

## 6. Convert the loop's stream to SSE / JSONL for the frontend

**Scenario.** HTTP endpoint returns the loop's `Stream<Event>` as
`text/event-stream` or `application/x-ndjson`.

**Composition.** Already supported:

```ts
conversation.pipe(
  Stream.map(toSseEvent), // user-defined: Event → SSE.Event
  SSE.toBytes, // already in src/SSE.ts
)
// or
conversation.pipe(Stream.map(JSON.stringify), JSONL.toBytes)
```

**Gaps.**

- We have `SSE.fromBytes`/`SSE.toBytes` and `JSONL`. **Missing:**
  `Schema`-driven encoders so a typed `Event` union round-trips without the
  user writing `toSseEvent` by hand.
  - `SSE.encodeWithSchema(schema)`: `Stream<A> -> Stream<Uint8Array>`
  - The ergonomic shape: discriminated-union `Event` schema → SSE's `event:`
    field comes from the discriminator, `data:` is the JSON-encoded payload.
- Browser-side reciprocal: `SSE.fromEventSource` adapter that wraps
  `EventSource` into a `Stream<SSE.Event>` so the same `Event` schema decodes
  on both ends.

**Primitive added:** `SSE.encodeWithSchema` / `SSE.decodeWithSchema`.
Optional: an `EventSource` adapter (browser) and a `WebSocket` adapter
(see #7).

---

## 7. Frontend → backend WebSocket input stream with debouncing

**Scenario.** Frontend opens a WS, types into a chat, sends each keystroke or
each "send" press as an event. Backend wants to (a) debounce so it doesn't
fire a generation on every keystroke, (b) collect everything that arrived
within the debounce window into one batch.

**Composition.** This is _input-driven_ rather than state-driven, but the
loop still applies — the body waits for an input batch before generating.

```ts
const inputs: Stream<UserAction, ...> = ws.toStream().pipe(
  Stream.groupedWithin(/* maxItems */ 100, /* duration */ "300 millis"),
  // each chunk is now a NonEmptyArray<UserAction> arriving at most every 300ms
)

// Drive the loop from inputs:
loop(initial, (state) =>
  Stream.unwrap(Effect.gen(function* () {
    const batch = yield* Stream.runHead(inputs).pipe(Effect.flatMap(Option.match({
      onNone: () => Effect.succeed(Stream.fromIterable<Event | Decision<State>>([stop])),
      onSome: (batch) => generateForBatch(state, batch),
    })))
    return batch
  })),
)
```

The cleaner shape is a queue:

```ts
const queue: Queue<UserAction> = ...  // fed by the WS handler
const body = (state) => Stream.unwrap(Effect.gen(function* () {
  const batch = yield* Queue.takeBetween(queue, 1, 100)
  // run a generation incorporating the batch
}))
```

**Gaps.**

- `Stream.groupedWithin(n, duration)` — debounce-and-batch — is a built-in
  Effect Stream operator. We don't need to ship it.
- `Stream.debounce(duration)` exists too (drops earlier values, emits the
  last after silence).
- WS adapter: `Stream.fromWebSocket`/`Stream.toWebSocket` would be useful as a
  small unstable-http wrapper. Not a primitive — just bindings.
- Open question: **should the loop primitive itself accept an input stream**
  rather than always being state-driven? Probably no — composition with
  `Queue` keeps the loop primitive small. Document the queue pattern.

**Primitive added: none** (Effect already ships `groupedWithin`/`debounce`).
Library helper: WS<->Stream adapters under `unstable/`.

---

## 8. Per-request token budget

**Scenario.** Each request gets 100k tokens. After that, stop the loop.

**Composition.** Two flavors.

**Per-turn check** (easy, current shape):

```ts
const after = { ...state, cumulativeTokens: state.cumulativeTokens + (turn.usage.totalTokens ?? 0) }
if (after.cumulativeTokens >= BUDGET) {
  return stopAfter(Stream.fromIterable([turnComplete, { type: "budget_exceeded", used: after.cumulativeTokens }]))
}
return nextAfter(...)
```

**Mid-stream cutoff** (harder):

The model only reports `usage` at `turn_complete`. To cut off mid-stream you
need a tokenizer to count `text_delta` on the fly:

```ts
deltas.pipe(
  Stream.scan({ tokens: 0 }, (acc, d) => ({
    tokens: acc.tokens + (d.type === "text_delta" ? countTokens(d.text) : 0),
  })),
  Stream.takeWhile(({ tokens }) => state.cumulativeTokens + tokens < BUDGET),
)
```

When `takeWhile` returns false, the stream ends → its scope closes →
finalizers (HTTP client) fire → fetch is aborted via the underlying
`AbortController`. **The structured-scope guarantee from Effect is what makes
mid-stream cutoff work.** Verify with a regression test (#10 also relies on
this).

**Gaps.**

- A bundled tokenizer Layer keyed on model id (`Tokenizer.layerOpenAi`,
  `Tokenizer.layerAnthropic`). The compass artifact calls out that bundled
  tokenizers inflate browser bundles; ship them as separate packages /
  unstable adapters.
- Convention: every `usage` field carries `inputTokens`, `outputTokens`,
  `totalTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens` —
  Phase 1 in `cuttlekit-use-cases.md`.

**Primitive added:** Tokenizer service interface + per-provider Layers.

---

## 9. Pause and resume

**Scenario.** Long-running agent. User hits "pause" — server should release
the HTTP connection. Later user hits "resume" — server picks up where it
left off.

**Composition.** Two regimes — important to separate.

**Soft pause** (in-process). The pull-based loop already gives this for
free: if downstream stops pulling, no more work happens. The body is paused
mid-pull. _But_ the underlying HTTP connection is held open the whole time.
This is fine for seconds-to-minute pauses; bad for hours.

**Hard pause** (cross-process / cross-request). Requires:

1. The body to checkpoint somewhere durable (e.g. after each `turn_complete`
   write `state` to KV).
2. The body to terminate the loop with `stop` after the checkpoint instead of
   `next`.
3. A separate request later loads the saved state and calls `loop(savedState, body)`.

For OpenAI Responses, the natural checkpoint key is `previousResponseId` —
already plumbed in `OpenAi.streamTurn`. Resume = pass `previousResponseId` so
the provider doesn't replay.

**Gaps.**

- A `pause(checkpoint)` decision in `Decision<S>` would let the body
  surface a serializable checkpoint as a terminal event instead of stop. It's
  not strictly necessary — `stop` plus a `checkpoint` event achieves the same
  thing. Lean: don't add it; recipe instead.
- `DurableEventLog` (Phase 4 of `cuttlekit-use-cases.md`) is the durability
  Layer. Ship the in-memory implementation now; real adapters (SQLite,
  Postgres, Redis, DO, Restate, Temporal, Inngest, Workflow DevKit) are
  separate packages.
- Recipe `recipes/pause-resume.md`: pause-after-turn pattern, schema for the
  checkpoint, where to drop a `cache_breakpoint` so cache survives the gap.

**Primitive added: none.** New service interface: `DurableEventLog` (Phase 4).

---

## 10. Mid-stream abort that cancels the LLM HTTP request

**Scenario.** User clicks "stop". Server must interrupt the loop _and_ abort
the upstream HTTP request to the model provider.

**Composition.** Effect's structured concurrency model already does this if
the chain is correctly scoped:

```
loop scope
  └── body's bodyScope  (forked from outer)
       └── Stream.toChannel(streamTurn(...))
            └── HttpClient.execute(...)  (registers AbortController in scope finalizer)
```

When the loop's outer scope closes:

- `Scope.addFinalizerExit` (already wired in `streamLoopPull.ts`) closes
  `current.scope`.
- That triggers the HTTP client's finalizer.
- `FetchHttpClient` aborts via `AbortController.abort()`.

The user-facing trigger:

```ts
const abort = yield * Deferred.make<void>()
conversation.pipe(Stream.interruptWhen(Deferred.await(abort)))
// elsewhere:
yield * Deferred.succeed(abort, undefined)
```

**Gaps.**

- **Verify** `FetchHttpClient` actually wires `AbortController` into the
  scope finalizer, not just the request's own `signal`. (Quick test: run a
  long stream against a slow mock provider, abort, assert the upstream
  `Request.signal.aborted === true`.)
- **Regression test in this repo:** drive `loop` with a body that calls a
  fake `streamTurn` whose finalizer flips a flag; cancel the outer stream
  mid-pull; assert the flag fired. This belongs in `streamLoop.test.ts`.
- Recipe `recipes/abort.md`: `Deferred` + `Stream.interruptWhen` and the
  cleanup chain.

**Primitive added: none.** Test + verification work.

---

## 11. Use cases from `cuttlekit-use-cases.md` and the compass artifact

Cross-checking against the broader use-case list. Marking each as **C**
(works by composition today), **+helper** (small library helper), or
**+primitive** (genuinely new).

### From `cuttlekit-use-cases.md`

| Use case                                              | Verdict                                 |
| ----------------------------------------------------- | --------------------------------------- |
| Reasoning blocks in `Items` schema (Phase 1)          | +primitive (schema)                     |
| Cache-breakpoint marker (Phase 1, 7)                  | +primitive (schema)                     |
| Usage extension fields                                | +primitive (schema)                     |
| `Items` helpers (append, dropLastTurn, replace, etc.) | +helper                                 |
| `interEventGap`, `between`, `count`, `summarize`      | +helper (Stream operators)              |
| Validation + retry pattern (Phase 3)                  | C — needs `Ref` capture pattern recipe  |
| `accumulateLinesWithFlush`                            | +helper                                 |
| Resumable streams + DurableEventLog (Phase 4)         | +primitive (service interface) — see #9 |
| Long-running conversation server (Phase 5)            | C — `Queue.takeBetween` + `loop`        |
| Provider-specific usage extraction (Phase 6)          | provider-internal, not user-facing      |

### From the compass artifact (top complaints)

| Pain point                                    | Verdict for our loop                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| Reasoning preservation across tool turns      | C if `Items` schema preserves reasoning (Phase 1) — the loop is agnostic         |
| Zod ↔ JSON Schema fidelity                    | provider-side; out of scope for `loop`                                           |
| Stream resumability + abort compose           | C **iff** we add the regression test (#10) and DurableEventLog Layer (#9)        |
| Prompt cache breakpoint placement             | C — `Items` schema work (Phase 1)                                                |
| Per-error-class retry policies (header-aware) | +primitive (typed `AiError` variants, `retry-after` header parsing) — see #3, #4 |
| Hidden tool-loop orchestration                | **already won** — the loop is fully visible by design                            |
| Cost tracking (token → USD)                   | +helper (`CostTracker` Layer + pricing table)                                    |
| Edge-runtime streaming                        | C — Effect runs on Workers; verify with regression test                          |
| Citations / grounded outputs                  | +primitive (schema additions in `Items`/`Turn`)                                  |
| MCP client                                    | out of scope for `loop`                                                          |
| Real-time / voice                             | out of scope for `loop`                                                          |
| Computer use                                  | C — it's just a tool; `Toolkit` already handles it                               |
| Provider fallback (`ExecutionPlan`)           | C — see #4                                                                       |

### Use cases not yet on either list (worth calling out)

1. **Human-in-the-loop tool approval.**
   Some tool calls (`delete_database`, `send_email`) require user approval
   before execution. State carries `pendingApprovals: ToolCall[]`. Body emits
   `awaiting_approval` events and `stop`s. A separate `resume(state, approvals)`
   call re-enters the loop with the approvals applied. **Verdict: C** —
   composition only; needs recipe.

2. **Streaming tool results.**
   Long-running tools (sandboxed code execution, web search) want to emit
   _progress_ events while running, not just one terminal `FunctionCallOutput`.
   Currently `Toolkit.executeOne` returns `Effect<FunctionCallOutput>` —
   single-shot. **Verdict: +primitive.** Add an alternate `Tool.streaming`
   shape that returns `Stream<ToolEvent | FunctionCallOutput>`, where the
   terminal event becomes the output fed back to the model and intermediate
   events stream through to the user. This is a real surface gap.

3. **Sub-agent / handoff.**
   Agent A delegates to agent B, which runs its own loop, returns a result.
   **Verdict: C** — `loop` returns a `Stream`, so a tool's handler can run
   `Stream.runFold` over a sub-`loop` and return its result. Recipe needed
   for "how to plumb sub-agent deltas into the parent stream" — this is the
   only subtle bit (you want sub-agent text to flow through, not be
   swallowed). Could be solved by `Tool.streaming` from #2.

4. **Concurrency limits across tool calls (parallel execution caps).**
   Already supported via `executeAll(toolkit, calls, { concurrency: 4 })`.
   **Verdict: C.**

5. **Per-tool timeout.**
   Wrap `executeOne` with `Effect.timeout(d).pipe(Effect.catchTag("TimeoutException", ...))`.
   **Verdict: C** — needs recipe + a `Tool.withTimeout(tool, d)` helper.

6. **Per-request rate limiting (header-aware).**
   `RateLimiter` Layer keyed on `gen_ai.request.model` + provider headers.
   **Verdict: +helper** built on top of typed `AiError.RateLimited.retryAfter`.

7. **Multi-modal input/output through the stream.**
   Image/audio/video deltas need delta types. `TurnDelta` currently has only
   `text_delta` / `reasoning_summary_delta` / `tool_call_*` / `turn_complete`.
   **Verdict: +primitive** in `Turn.ts` schema (Phase 1 territory).

8. **Mid-turn user message injection ("interrupt and add context").**
   User adds a clarifying message _while_ a turn is generating. Two variants:
   (a) abort current turn and restart with new history (composition: scope
   abort + restart loop), (b) hold the message until next turn (composition:
   queue + drain at body start). **Verdict: C** — recipes only.

9. **Eval / replay mode.**
   Run the same loop against a recorded delta tape to test agent logic
   deterministically. **Verdict: C** — `LanguageModelService` is a `Layer`,
   swap in a tape-driven mock. We already do this in tests.

10. **OTel-conformant tracing of the loop.**
    Each turn becomes a `gen_ai.completion` span; tool calls become child
    spans; the whole loop is the parent. **Verdict: +helper** (`withSpan`
    wrappers in `LanguageModel` and `Toolkit.executeOne`).

11. **Backpressure-aware fan-out (PubSub for resumable streams).**
    Phase 4 of `cuttlekit-use-cases.md` — pair `PubSub` with
    `DurableEventLog` so multiple consumers can subscribe live or replay
    from offset. **Verdict: +primitive** (DurableEventLog interface only —
    PubSub is built-in).

---

## 12. Summary — what to add to the library

Ranked by leverage (each item unlocks N use cases above).

### Tier 1 — primitives that unlock multiple use cases

1. **Typed `AiError` variants** — `RateLimited` (with `retryAfter`),
   `Unavailable`, `Timeout`, `ContentFiltered`, `InvalidRequest`, `AuthFailed`.
   **Unlocks:** #3, #4, #11.6 (rate limiter), retry recipes.
2. **`Stream.retryUntilFirstEmit(schedule)`** — safe retry that stops being
   active once the stream has emitted anything. **Unlocks:** #3 cleanly,
   #4 partially.
3. **`Tool.streaming` variant** — `run: () => Stream<ToolEvent | FunctionCallOutput>`,
   loop reads the terminal `FunctionCallOutput` as the model-visible result.
   **Unlocks:** #11.2 (streaming tool results), #11.3 (sub-agents).
4. **`Items.ts` schema additions** (Phase 1 of cuttlekit-use-cases): reasoning
   blocks, `cache_breakpoint`, extended `Usage` (cache + reasoning tokens),
   multi-modal content blocks.
   **Unlocks:** #5 (compaction), #11.7 (multi-modal), reasoning preservation,
   cache strategy.
5. **`DurableEventLog` service interface + in-memory impl.**
   **Unlocks:** #9 (pause/resume), Phase 4 of cuttlekit-use-cases.

### Tier 2 — focused helpers

6. **`executeAllSafeWithStatus`** (or extend `FunctionCallOutput` with
   `status`) — typed tool failure detection. **Unlocks:** #1.
7. **`SSE.encodeWithSchema(schema)` / `decodeWithSchema(schema)`** —
   schema-driven event codecs. **Unlocks:** #6.
8. **Tokenizer service interface + per-provider Layers** (in separate
   packages). **Unlocks:** #8 (mid-stream budget), cost tracking.
9. **`CostTracker` Layer + pricing table** keyed on `gen_ai.request.model`.
   **Unlocks:** observability, the compass artifact's "cost as OTel metric"
   whitespace.

### Tier 3 — recipes (no new code, just docs)

10. Control-tools pattern (#2).
11. Auto-compaction (#5).
12. Pause/resume (#9).
13. Mid-stream abort (#10).
14. HITL approval (#11.1).
15. Sub-agent delegation (#11.3).
16. WebSocket input + debouncing (#7).

### Tier 4 — verification work (regression tests, no new surface)

17. Verify `FetchHttpClient` aborts upstream on scope close (#10).
18. Verify the full pull chain backpressures end-to-end against a slow
    consumer (existing nicety, not yet asserted).
19. Edge-runtime smoke test (Workers / Bun) — the compass artifact
    flagged this as a competitor weakness; we should be able to
    demonstrate it works.

---

## 13. What the loop primitive itself does NOT need

After this audit, the `loop(initial, body)` primitive holds up against every
scenario considered. Things deliberately **not** added to the loop:

- **No `pause` decision.** `stop` plus a checkpoint event covers it; adding
  `pause` would couple the loop to a particular durability model.
- **No built-in retry.** Belongs at the body level via `Stream.retry` /
  `retryUntilFirstEmit`. A loop-level retry hides which iteration retried.
- **No built-in fallback / `ExecutionPlan` integration.** State threading +
  typed errors is more flexible. Recipe shows both flavors.
- **No input-stream variant.** Queue + body composition keeps the primitive
  small.
- **No "max iterations" knob.** State counter does it; a max-iterations cap
  is a one-liner in the body and varies per agent (turns vs tool calls vs
  budget).
- **No tool execution baked in.** `Toolkit.executeAllSafe` is a separate
  composition. The loop is agnostic — that's the whole point.

The single conviction this audit reinforces: **state, decision, body — that
is enough.** Everything else is composition or a small focused helper.
