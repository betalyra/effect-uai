# Plan — implementing cuttlekit-derived use cases

Use cases identified from reviewing `cuttlekit/.../generate/{service,tools,prompts}.ts`
and `.../durable/processor.ts`. Items are ordered by foundational dependency,
not by user-facing impact.

Naming: each phase lists **changes** (library code), **recipes** (docs/code
snippets users copy), and **tests** (proofs the design holds).

---

## Phase 1 — Foundations (Schema + message helpers)

These unblock several later phases. Small, mostly mechanical.

### Changes
- [`src/Items.ts`](../src/Items.ts)
  - Add `Reasoning` content block: `{ type: "reasoning", text, signature? }`. Allow it inside `Message.content`. Anthropic's signed thinking lives in `signature`.
  - Add `ReasoningItem` (top-level item) for Responses-API alignment.
  - Add a `cache_breakpoint` marker — either as an item type or as an annotation on a content block. Decide: separate item is simpler, easier to enforce ordering.
  - Add helpers: `append`, `dropLast(n)`, `dropLastTurn`, `replace(predicate, fn)`, `remove(predicate)`, type guards (`isAssistantMessage`, `isFunctionCall`, `isFunctionCallOutput`, `isReasoning`).
- [`src/Turn.ts`](../src/Turn.ts) / [`src/Items.ts`](../src/Items.ts)
  - Make `Usage` fields `Schema.optional` / `Schema.NullOr`. Add `cache_read_tokens`, `cache_write_tokens` as optional fields.
  - Add `reasoning_tokens`, `thinking_tokens` as optional too.

### Tests
- Schema decode/encode round-trip for messages with reasoning blocks.
- Helpers: assert `dropLastTurn` removes assistant items + any tool outputs after them.

---

## Phase 2 — Metric building blocks expansion

Use case: per-event/per-tool/inter-event timing (cuttlekit tracks `sinceLastEvent_ms`,
per-tool duration, per-step elapsed). Generalize as Stream operators.

### Changes
- [`src/Metrics.ts`](../src/Metrics.ts) (additions, all generic over `Stream<A>`)
  - `interEventGap`: annotate each event with `Duration` since the previous event. First event reports the same value as `withElapsed`.
  - `between(startPredicate, endPredicate)`: emit a `Duration` every time a `start` event is followed by an `end` event. Works for tool start/result pairs, step boundaries, etc.
  - `count(predicate)`: running count of events matching predicate, annotated alongside each event.
  - `summarize(reducer, initial)`: thin wrapper of `Stream.runFold` with a clear name for "aggregate this whole stream into one value at the end" — lets users build a stats event without learning Stream.runFold by name.

### Recipes
- `recipes/stats-final-event.md`: pattern for emitting a stats summary as a terminal stream event via `Stream.concat(content, Stream.fromEffect(buildStats))`.
- `recipes/per-tool-duration.md`: `between(d => d.type === "tool_call_start", d => d.type === "tool_result_received")` (requires adding tool result events to TurnDelta — see open question 1 below).

### Tests
- `interEventGap` over paced mock stream — assert gap == `deltaInterval`.
- `between` over a synthetic stream of start/end pairs.
- Stats-as-final-event with `TestClock`.

---

## Phase 3 — Validation + retry pattern (the cuttlekit headline)

Use case: stream-validate-the-LLM's-output (free-form text or structured tool args
or a custom protocol) and retry the whole stream with a corrective prompt that
includes preserved-partial-work. Generalizes "tool repair" beyond tool calls.

### Changes
- [`src/Stream.ts`](../src/) **(new file — small grab-bag of Stream operators that aren't AI-specific)**
  - `accumulateLinesWithFlush`: turn a `Stream<string>` into `Stream<string>` of newline-delimited lines. Cuttlekit ships their own; ours can be a published 8-line implementation.
  - Maybe `accumulateUntil(predicate)`: more general version.
- No other library code changes needed — the pattern is composition.

### Recipes
- `recipes/structured-output-streaming.md`: full pattern for "LLM streams a custom protocol, validate per-line, retry the stream on failure." Steps:
  1. `Stream.unwrap` to capture per-attempt state in a `Ref`.
  2. `Stream.mapEffect(parseAndValidate)` — fail with a tagged error on validation failure.
  3. `Stream.tap` to record successful units into the Ref.
  4. `Stream.catchTag(YourError, err => recursivelyRetryWithCorrectivePrompt)`.
  5. The corrective prompt builder reads the Ref and partitions: keep the parts that succeeded, reset the rest, inject context.
- `recipes/tool-call-validation.md`: same pattern but for tool calls — when the LLM emits an unparseable tool call, retry-with-correction instead of feeding back as `function_call_output`. Two flavors of repair, user picks.

### Tests
- `test/structured-output.test.ts`: scripted mock emits 3 JSONL lines where line 2 is malformed. Test asserts:
  - Stream catches the validation error.
  - Mock is called a second time with a corrective prompt that includes line 1 (success) and the bad-line message.
  - The retry succeeds and lines 1+3 are emitted to the consumer (line 2 was skipped or replaced).

---

## Phase 4 — Resumable streams via durable event log + PubSub

Use case: `processor.ts` pairs `PubSub` (low-latency fan-out) with a `DurableEventLog`
(persisted by offset). Clients can resume from any offset. This is research's #3 complaint
("stream resumability and abort do not compose").

### Changes
- [`src/Durable.ts`](../src/) **(new file)**
  - `DurableEventLog` `Context.Service` interface:
    - `append(sessionId, offset, event): Effect<void>`
    - `readFrom(sessionId, offset): Stream<Event>`
    - `getLatestOffset(sessionId): Effect<number>`
  - In-memory implementation as `DurableEventLog.layerInMemory`. No real persistence — for tests/dev. Real adapters (SQLite/Postgres/Redis/Durable Object) are separate Layers, not in this PoC.
- No changes to `LanguageModel` / `Conversation` / `Items`.

### Recipes
- `recipes/resumable-stream.md`:
  1. `Stream.broadcast(stream, 2)` to fan out to PubSub + log.
  2. `Stream.mapAccum` to assign offsets.
  3. `Stream.tap(persist) >> Stream.tap(publish)`.
  4. Resume = `Stream.concat(eventLog.readFrom(sid, offset), pubsub.subscribe)`.

### Tests
- `test/durable.test.ts`:
  - Run a generation through the durable pipeline.
  - Crash-resume: a second consumer requests events from offset 3; gets the persisted tail then live events.
  - Use `TestClock` to drive timing if needed.

---

## Phase 5 — Long-running conversation server

Use case: `runProcessingLoop` is `Effect.forever(drainQueue >> generate >> publish)`
with `Effect.catchAllCause` to keep the loop alive. Different shape from one-shot
paginate: it's the *agent server*, not the *agent stream*.

### Changes
- None to library — this is composition.

### Recipes
- `recipes/conversation-server.md`:
  1. `Queue.takeBetween(actionQueue, 1, MAX_BATCH)` → batch of actions.
  2. Build messages from batch (recipe shows the user's own builder).
  3. Run `Stream.paginate` with a step that uses `provideService` + tools.
  4. `Stream.tap(persistAndPublish)`.
  5. `Effect.catchAllCause(logAndContinue)` outside `Effect.forever`.

### Tests
- `test/server.test.ts`: queue of 5 actions, processed in batches of 2, asserts 3 generation cycles ran, each saw the right batch. No new library code needed.

---

## Phase 6 — Provider-specific usage extraction (real-provider prep)

Use case: providers report usage differently. Cuttlekit centralizes via
per-model `extractUsage(rawUsage) -> Usage`. We want this baked into the
provider contract, not retrofitted.

### Changes
- [`src/LanguageModel.ts`](../src/LanguageModel.ts)
  - Add `extractUsage` as an optional method on `LanguageModelService`? Or: providers normalize internally and `Turn.usage` is always normalized. Lean toward the latter — providers do their own extraction, the framework only sees the normalized shape.
- Define `Usage` extension fields (cache reads/writes, reasoning tokens) in [`src/Items.ts`](../src/Items.ts) (Phase 1).

### Tests
- A second mock provider that emits a "raw usage" shape and normalizes it before emitting `turn_complete`. Assert the consumer sees normalized fields only.

---

## Phase 7 — Cache-breakpoint-aware messages

Use case: prompt caching cost optimization (research #4). Cuttlekit orders messages
"static → less static → most volatile" deliberately. We should make breakpoints
first-class so providers can't silently strip or reorder them.

### Changes
- [`src/Items.ts`](../src/Items.ts) (Phase 1 already adds the marker)
  - A `CacheBreakpoint` item or content block with optional TTL hint.
  - A check/filter that warns if breakpoints aren't followed by *static* content (heuristic).
- Provider implementations honor or fail loudly if they can't.
- This phase is mostly schema + provider-side enforcement; no loop changes.

### Recipes
- `recipes/prompt-caching.md`: how to structure messages for max cache hits, where to drop breakpoints, how to verify hits via `Usage.cache_read_tokens`.

### Tests
- Round-trip a cache-breakpoint through the schema.
- A mock provider that asserts breakpoints arrive in expected positions; fail if reordered.

---

## Phase 8 — A real provider (OpenAI Responses API)

Out of scope for this plan but the natural next step after Phase 1–7. The mock
provider's contract is what a real provider has to satisfy: stream `TurnDelta`
events, terminate with `turn_complete` carrying normalized `Usage`, validate
wire-correctness at the boundary. Build incrementally: text-only → function
calls → reasoning → cache control → structured output.

---

## Open questions to resolve before starting Phase 2/3

1. **Tool result events in `TurnDelta`?** Currently the delta stream ends at `turn_complete`; tool execution happens *outside* the stream in user code. For Phase 2's `between(toolCallStart, toolResult)` metric, we'd need tool-result events to be observable in the same stream — either by wrapping the user's tool execution in a tap, or by emitting "synthetic" deltas around it. **Lean: provide a tiny helper that wraps `Toolkit.executeAll` and emits start/end events to a separate sink (PubSub or Stream), so metrics can subscribe without polluting the LLM stream.**

2. **Cursor semantics — pre-tools or post-tools?** Currently cursors emit pre-tool-execution. For "stats as final event" the user wants the *final* cursor to reflect post-tool state. Either change the default or expose both — `cursor.preToolHistory` and `cursor.postToolHistory`. **Lean: keep cursor as pre-tools (matches the LM's view); document that "what your code added" = `nextCalls[N+1].history − cursor.history`.**

3. **`Stream.broadcast` vs custom fan-out for resumable streams?** `Stream.broadcast(n)` is built-in but the consumer count is fixed. A real subscribe-anytime pattern needs `PubSub`. **Lean: ship a recipe using `PubSub` + `Hub`; not a library helper.**

---

## Suggested execution order

1. **Phase 1** (foundations) — small, unblocks everything.
2. **Phase 2** (metrics expansion) — natural extension of what just shipped, low risk.
3. **Phase 3** (validation + retry pattern) — the highest-impact recipe, validates the "user owns the loop" thesis on a real cuttlekit pain point.
4. **Phase 4** (resumable streams) — research-grounded differentiator.
5. **Phase 5** (server pattern) — small, mostly recipes.
6. **Phase 6** (provider-specific usage) — needed before real providers.
7. **Phase 7** (cache breakpoints) — needed before serious production use.
8. **Phase 8** (real provider) — separate effort.
