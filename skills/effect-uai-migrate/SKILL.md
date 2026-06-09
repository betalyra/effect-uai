---
name: effect-uai-migrate
description: Use when the user is upgrading effect-uai across versions, sees compile errors after a version bump, or asks Claude to "update my effect-uai code to the latest". Encodes per-version rename tables and behavior changes so Claude can rewrite call sites mechanically without re-reading the changelog each time.
license: MIT
---

# effect-uai migrate

Use this skill when the user is upgrading from one effect-uai release
to a newer one. It contains the consolidated rename and removal rules
for each release, in the form Claude needs to apply rewrites:
"if you see X, write Y, here's the why."

Reach for this when the user says any of:

- "I bumped effect-uai and everything broke"
- "Update my code to the latest effect-uai"
- "What changed in 0.5?"
- "How do I migrate from 0.4 to 0.5?"

## How to use this skill

1. Identify the source version (look at `package.json` or ask).
2. Walk the version tables below in order, applying each rewrite to
   the user's code.
3. After each rewrite, run typecheck (`pnpm typecheck` or equivalent)
   to confirm.
4. Skip "optional" rewrites unless the user asks to modernize.

The full migration prose (with rationale and edge cases) lives in
`docs/migrations/v{X.Y}.md`. This skill is the operator-mode summary.

---

## 0.7 → 0.8

**No rewrites needed.** 0.8 is purely additive: a new `WebSearch`
capability in `@effect-uai/core` (generic `WebSearch` service + `search`
helper + `webSearchTool`), and three search providers
(`@effect-uai/perplexity`, `@effect-uai/exa`, `@effect-uai/tavily`).
Nothing in the existing surface changed. Bump dependencies, run typecheck,
done.

If the user sees a 0.8-version compile error that looks like a rename
(`durationSeconds`, `GeminiTranscriber`, `prompts`, `bpm`, etc.), they are
actually on 0.6 or older, so apply the **0.6 → 0.7** rules below (and the
earlier sections) first.

### New-code patterns (only if the user is adopting search)

```ts
// Generic search call, portable across providers
import { search } from "@effect-uai/core/WebSearch"
const { results } = yield * search({ query: "..." })

// Ground an LLM: the tool requires WebSearch; app policy on the
// constructor, the model only picks `query` (+ optional `recency`)
import { webSearchTool } from "@effect-uai/core/WebSearchTool"
const tools = [webSearchTool({ maxResults: 5 })]

// Provide a backend (plus an HttpClient). Swap the layer to switch.
import { layer as perplexity } from "@effect-uai/perplexity/PerplexitySearch"
// or @effect-uai/exa/ExaSearch, @effect-uai/tavily/TavilySearch
```

The full tour is in
[Migrating to 0.8](https://effect-uai.betalyra.com/migrations/v0-8/) and
the [Web search overview](https://effect-uai.betalyra.com/search/).

---

## 0.6 → 0.7

A capability-honesty pass across audio and embeddings. Three flavors of
change: (1) mechanical renames (mostly `durationSeconds → duration`),
(2) one removed module (`GeminiTranscriber`), (3) requests that now fail
`AiError.Unsupported` or `warnDropped` where 0.6 degraded silently. The
type renames are find-and-replace; the silent-to-error changes need a
judgement call per call site (drop the field, switch provider, or handle
the new error).

### Required rewrites

#### Removed: `GeminiTranscriber`

`@effect-uai/google/GeminiTranscriber` is deleted (it was an LLM with a
"transcribe" prompt, not a real STT endpoint). No drop-in replacement;
switch to a real transcription provider.

```ts
// Before
import * as GeminiTranscriber from "@effect-uai/google/GeminiTranscriber"

// After — pick an in-tree STT provider
import * as OpenAITranscriber from "@effect-uai/openai/OpenAITranscriber"
// or @effect-uai/elevenlabs/ElevenLabsTranscriber (diarization on sync)
// or @effect-uai/inworld/InworldTranscriber
```

`GeminiTranscribeRequest` and `GeminiSttModel` are gone with it.

#### `durationSeconds: number` → `duration: Duration.Duration`

Applies to `AudioBlob` (TTS / music output) and `TranscriptResult` (STT).
Per-word offsets (`WordTimestamp.startSeconds` / `endSeconds`) stay raw
`number`.

```ts
// Before
const secs = blob.durationSeconds // number | undefined

// After
import { Duration } from "effect"
const secs = blob.duration ? Duration.toSeconds(blob.duration) : undefined
// Constructing: duration: Duration.seconds(30)
```

#### Flat renames / removals

| Before                                                           | After                                                               |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `AudioBlob.durationSeconds` / `TranscriptResult.durationSeconds` | `.duration` (`Duration.Duration`)                                   |
| `transcribe({ prompt: { terms: [...] } })`                       | `transcribe({ biasingTerms: [...] })`                               |
| `CustomPronunciation` `{ …, encoding: "ipa" }`                   | `{ phrase, pronunciation }` (drop `encoding`, IPA-only)             |
| `PhoneticEncoding` (type)                                        | removed (no replacement)                                            |
| `DialogueTurn` `{ …, styleDescription, speed }`                  | `{ voiceId, text }` (drop the two extra fields)                     |
| `EmbedEncoding` = `… "sparse" \| "multivector"`                  | `"float32" \| "int8" \| "binary"` (use `JinaEncoding` for the rest) |
| `embed({ encoding: "sparse" \| "multivector" })` (generic)       | `JinaEmbedding.asEffect()` then `jina.embed({ encoding })`          |

`prompt?: string` still exists on `CommonTranscribeRequest` (prose
context). Only the `{ terms }` union arm moved to `biasingTerms`.

### Behavior changes (no rewrite, but observable)

Apply only if the call site relied on the old silent behavior or matches
on the error tag:

- **Embeddings, generic path**: a non-`float32` `encoding` on OpenAI /
  Gemini (and scalar `int8` on Jina) now fails `Unsupported` instead of
  returning a mislabeled float32. Omit `encoding` or pass `"float32"`.
- **Embeddings**: OpenAI image input and Jina multi-part input now fail
  `Unsupported` (were `InvalidRequest`). OpenAI `task` now `warnDropped`.
- **TTS**: `pronunciations` now fails `Unsupported` on OpenAI / Gemini /
  modern ElevenLabs (no IPA path). Drop them, switch to Inworld, or use
  ElevenLabs `pronunciationDictionaryLocators`.
- **STT**: stream `inputFormat` gaps now fail `Unsupported` (were
  `InvalidRequest`). OpenAI no longer accepts `diarization` on its typed
  request, and a non-`whisper-1` `wordTimestamps` request now surfaces the
  wire 400 rather than a pre-send `Unsupported`.
- **LLM**: Gemini `toolChoice` is now applied (was forced to AUTO and
  ignored). Gemini `url`-source images now fail `Unsupported` (were
  silently dropped); pass base64 / bytes.

### After-migration checklist

- [ ] No imports from `@effect-uai/google/GeminiTranscriber`
- [ ] No `.durationSeconds` reads on `AudioBlob` / `TranscriptResult`
- [ ] No `prompt: { terms: [...] }`; vocabulary biasing on `biasingTerms`
- [ ] No `encoding` field on `CustomPronunciation`; no `PhoneticEncoding`
- [ ] No `styleDescription` / `speed` on `DialogueTurn`
- [ ] No `"sparse"` / `"multivector"` passed to generic `embed` /
      `embedMany` (use the `JinaEmbedding` service)
- [ ] Error handlers updated for the `InvalidRequest → Unsupported` shifts
- [ ] `pnpm typecheck` clean
- [ ] Tests pass

---

## 0.5 → 0.6

The "consistent naming" sweep (0.6 also adds multi-speaker dialogue and
custom pronunciations on `SpeechSynthesizer` — additive, no rewrites).
Almost entirely find-and-replace; the only judgement call is the `Loop`
helper trim. **Wire literals (`"function_call"`, `"function_call_output"`)
do not change** — only type and helper names do, so provider payloads
and on-the-wire pattern matching stay identical.

### Required rewrites

#### Module moves

| Before                       | After                         |
| ---------------------------- | ----------------------------- |
| `@effect-uai/core/Outcome`   | `@effect-uai/core/ToolResult` |
| `@effect-uai/core/Resolvers` | `@effect-uai/core/Approval`   |

#### Flat renames

| Before                                      | After                               |
| ------------------------------------------- | ----------------------------------- |
| `Item`                                      | `HistoryItem`                       |
| `FunctionCall`                              | `ToolCall`                          |
| `FunctionCallOutput`                        | `ToolCallOutput`                    |
| `Items.functionCallOutput(…)`               | `Items.toolCallOutput(…)`           |
| `Items.isFunctionCall`                      | `Items.isToolCall`                  |
| `Items.isFunctionCallOutput`                | `Items.isToolCallOutput`            |
| `Turn.functionCalls(turn)`                  | `Turn.getToolCalls(turn)`           |
| `Turn.appendTurn(…)`                        | `Turn.appendToHistory(…)`           |
| `Turn.toStructured(…)`                      | `Turn.decodeStructured(…)`          |
| `ToolResult.Value` / `isValue`              | `ToolResult.Ok` / `isOk`            |
| `rejected(call, kind, reason)`              | `failed(call, kind, reason)`        |
| `toFunctionCallOutput(…)`                   | `toToolCallOutput(…)`               |
| `Toolkit.executeAll(…)`                     | `Toolkit.run(…)`                    |
| `Toolkit.continueWith(…)`                   | `Toolkit.continueWithResults(…)`    |
| `Tool.AnyKindTool`                          | `Tool.AnyTool`                      |
| `ToolEvent.Intermediate` / `isIntermediate` | `ToolEvent.Progress` / `isProgress` |
| `Loop.loopFrom(…)`                          | `Loop.loopOver(…)`                  |
| `Loop.Event<A, S>`                          | `Loop.Step<A, S>`                   |
| `ToolCallDecision`                          | `ApprovalDecision`                  |
| `fromApprovalMap(…)`                        | `fromMap(…)`                        |
| `fromVerdictQueue(…)`                       | `fromQueue(…)`                      |
| `fromQueue(…).announce`                     | `fromQueue(…).approvalRequests`     |

The `Failure` variant, the `denied` / `cancelled` / `executionError`
synthesizers, `approve` / `reject`, and the `approved` / `decisions`
fields keep their names.

#### Removed: `Toolkit.make` / `Toolkit.toDescriptors`

Build a flat array of tools (plain, streaming, or mixed) and render it
with `Tool.toDescriptors`.

```ts
// Before
const toolkit = Toolkit.make([getTime, lookupWeather])
const descriptors = Toolkit.toDescriptors(toolkit)

// After
import * as Tool from "@effect-uai/core/Tool"
const descriptors = Tool.toDescriptors([getTime, lookupWeather])
```

#### Trimmed Loop helpers: `stop` / `next` are streams, `*After` gone

`next(state)`, `stop()`, and `stop(state)` each emit a single terminal
step. Concatenate your values in front of them; `stopWith(state)`
collapses into `stop(state)`.

| Before                            | After                                                           |
| --------------------------------- | --------------------------------------------------------------- |
| `return stop`                     | `return stop()`                                                 |
| `return stopWith(state)`          | `return stop(state)`                                            |
| `return nextAfter(stream, s)`     | `return stream.pipe(Stream.map(value), Stream.concat(next(s)))` |
| `return stopAfter(stream)`        | `return stream.pipe(Stream.map(value), Stream.concat(stop()))`  |
| `return stopWithAfter(stream, s)` | `return stream.pipe(Stream.map(value), Stream.concat(stop(s)))` |

`stopEvent` and `nextAfterFold` are removed with no direct replacement —
build the step stream from `value` / `next` / `stop` plus standard
`Stream` combinators.

#### Canonical loop body

```ts
// Before
onTurnComplete<State, ToolEvent>((turn) => {
  const calls = Turn.functionCalls(turn)
  if (calls.length === 0) return stop
  return Toolkit.executeAll(tools, calls).pipe(
    Toolkit.continueWith((results) =>
      Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
    ),
  )
})

// After
onTurnComplete<State, ToolEvent>((turn) => {
  const calls = Turn.getToolCalls(turn)
  if (calls.length === 0) return stop()
  return Toolkit.run(tools, calls).pipe(
    Toolkit.continueWithResults((results) =>
      Turn.appendToHistory(state, turn, results.map(toToolCallOutput)),
    ),
  )
})
```

### After-migration checklist

- [ ] No imports from `@effect-uai/core/Outcome` or `@effect-uai/core/Resolvers`
- [ ] No remaining `executeAll` / `continueWith` / `appendTurn` /
      `functionCalls` / `toStructured` / `toFunctionCallOutput` references
- [ ] No `Item` / `FunctionCall` / `FunctionCallOutput` type names
      (wire literals `"function_call"` / `"function_call_output"` stay)
- [ ] No `Toolkit.make` / `Toolkit.toDescriptors`; tools rendered via
      `Tool.toDescriptors([...])`
- [ ] No `nextAfter` / `stopAfter` / `stopWithAfter` / `stopWith` /
      `loopFrom`; `stop` called as `stop()`
- [ ] No `ToolEvent.Intermediate` / `isIntermediate`
- [ ] `pnpm typecheck` clean
- [ ] Tests pass

---

## 0.4 → 0.5

### Required rewrites

#### Reshape: `TurnEvent` is a `Data.TaggedEnum`

Discriminator renamed `type` → `_tag`; variants snake_case → PascalCase.

| Before                                             | After                                             |
| -------------------------------------------------- | ------------------------------------------------- |
| `{ type: "text_delta", text }`                     | `TurnEvent.TextDelta({ text })`                   |
| `{ type: "reasoning_delta", text, kind }`          | `TurnEvent.ReasoningDelta({ text, kind })`        |
| `{ type: "refusal_delta", text }`                  | `TurnEvent.RefusalDelta({ text })`                |
| `{ type: "tool_call_start", call_id, name }`       | `TurnEvent.ToolCallStart({ call_id, name })`      |
| `{ type: "tool_call_args_delta", call_id, delta }` | `TurnEvent.ToolCallArgsDelta({ call_id, delta })` |
| `{ type: "usage_update", usage }`                  | `TurnEvent.UsageUpdate({ usage })`                |
| `{ type: "turn_complete", turn }`                  | `TurnEvent.TurnComplete({ turn })`                |

```ts
// Before
import type { TurnEvent } from "@effect-uai/core/Turn"
if (event.type === "turn_complete") use(event.turn)
Match.value(event).pipe(
  Match.discriminators("type")({ text_delta: ..., turn_complete: ... }),
  Match.exhaustive,
)

// After
import { TurnEvent } from "@effect-uai/core/Turn"   // value, not just type
if (event._tag === "TurnComplete") use(event.turn)
Match.value(event).pipe(
  Match.discriminators("_tag")({ TextDelta: ..., TurnComplete: ... }),
  Match.exhaustive,
)
```

`Turn.isTurnComplete` and `Turn.textDeltas` still work — they were
updated internally.

### Within 0.5.x: 0.5.0/0.5.1 → 0.5.2

Two breaking renames. Mechanical.

#### `LanguageModel.retry` → `Retry.stream`

```ts
// Before
import { retry, Retryable } from "@effect-uai/core/LanguageModel"
streamTurn(req).pipe(retry(schedule))

// After
import * as Retry from "@effect-uai/core/Retry"
streamTurn(req).pipe(Retry.stream(schedule)) // Stream surfaces
embed(req).pipe(Retry.effect(schedule)) // Effect surfaces
```

`Retryable` / `isRetryable` move to the same module.

#### Hand-rolled `LanguageModelService` needs a `turn` field

`turn` is now on the service alongside `streamTurn`. Provider layers
and `MockProvider` are fine; custom test services need both fields:

```ts
// Before
const service: LanguageModelService = {
  streamTurn: () => ...,
}

// After
import { turnFromStream } from "@effect-uai/core/LanguageModel"
const streamTurn: LanguageModelService["streamTurn"] = () => ...
const service: LanguageModelService = { streamTurn, turn: turnFromStream(streamTurn) }
```

### Continuing the 0.4 → 0.5 list

#### Reshape: `ToolCallDecision` is a `Data.TaggedEnum`

```ts
// Before
const d: ToolCallDecision = { _tag: "Approved", call }

// After
import { ToolCallDecision } from "@effect-uai/core/Resolvers"
const d = ToolCallDecision.Approved({ call })
// or unchanged sugar:
const d = Resolvers.approve(call)
```

#### Removed: `Toolkit.outputEvent` / `Toolkit.outputEvents`

```ts
// Before
import { outputEvent, outputEvents } from "@effect-uai/core/Toolkit"
outputEvent(result)
outputEvents(results)

// After
import { ToolEvent } from "@effect-uai/core/ToolEvent"
import { Stream } from "effect"
ToolEvent.Output({ result })
Stream.fromIterable(results.map((result) => ToolEvent.Output({ result })))
```

#### Rename: `Encoding` → `EmbedEncoding`

```ts
// Before
import type { Encoding } from "@effect-uai/core/EmbeddingModel"

// After
import type { EmbedEncoding } from "@effect-uai/core/EmbeddingModel"
```

Avoids the clash with Effect's `Encoding` module. Provider-typed
unions (`JinaEncoding`, etc.) are unchanged.

### Optional modernizations

#### `EmbedResponse<E>` is now generic

Type-level reshape — runtime behavior unchanged.

```ts
// Before — narrow at runtime
const { embedding } = yield * embed({ model, input, encoding: "float32" })
if (embedding._tag !== "float32") return
embedding.vector

// After — narrowed by type
const { embedding } = yield * embed({ model, input, encoding: "float32" })
embedding.vector // Float32Array directly
```

Bare `EmbedResponse` still works (defaults to `Float32Embedding`).

#### `Loop.stopWith(state)` for `loopFrom` / `loopWithState`

Terminal event that ends the loop AND carries final state. Use it when
you want a clean "this input is done, here's the state to carry
forward" signal in `loopFrom`, or to capture the last state in
`loopWithState`'s `SubscriptionRef`. Plain `loop` treats it like
`stop`.

#### `Loop.loopFrom(input, initial, body)`

Input-driven sibling of `loop`. For each item from `input`, runs an
inner seed-driven `loop` with `(s) => body(s, item)`. State threads
across items via `next` / `stopWith`.

#### `LanguageModel.turn(request)` instead of draining manually

```ts
// Before
const events = yield * Stream.runCollect(streamTurn(request))
const turn = events.findLast(Turn.isTurnComplete)?.turn

// After
const turn = yield * LanguageModel.turn(request) // fails with IncompleteTurn if missing
```

#### `Retry.stream(schedule)` / `Retry.effect(schedule)` for the retryable subset

```ts
import * as Retry from "@effect-uai/core/Retry"

const schedule = Schedule.exponential("200 millis").pipe(Schedule.compose(Schedule.recurs(3)))

// Stream — streamTurn / streamSynthesis / streamTranscriptionFrom
streamTurn(request).pipe(Retry.stream(schedule))

// Effect — turn / embed / synthesize / transcribe
embed(request).pipe(Retry.effect(schedule))
// Retries RateLimited / Unavailable / Timeout. Other AiErrors propagate.
```

#### `Turn.assistantText(turn)` for the concatenated reply

```ts
const text = Turn.assistantText(turn) // string
const texts = Turn.assistantTexts(turn) // ReadonlyArray<string>
```

#### `Tool.fromStandardSchema(schema)` for Zod / Valibot / ArkType

```ts
const lookupWeather = Tool.make({
  name: "lookup_weather",
  inputSchema: Tool.fromStandardSchema(z.object({ city: z.string() })),
  run: ({ city }) => ...,
})
```

Effect Schema users keep `fromEffectSchema`.

### After-migration checklist

- [ ] No remaining `event.type === "text_delta"` (etc.) discriminations
- [ ] No remaining `Match.discriminators("type")({ text_delta: ... })`
- [ ] No remaining `Toolkit.outputEvent` / `outputEvents` imports
- [ ] `import { TurnEvent }` (value), not `import type { TurnEvent }`,
      wherever variants are constructed
- [ ] No remaining `Encoding` imports from `@effect-uai/core/EmbeddingModel`
- [ ] No remaining `"_tag" in event` hacks to distinguish `TurnEvent`
      from `ToolEvent` (both now use `_tag`)
- [ ] `pnpm typecheck` clean
- [ ] Tests pass

---

## 0.3 → 0.4

**No rewrites needed.** 0.4 is purely additive: new `Transcriber` /
`SpeechSynthesizer` / `MusicGenerator` services, shared `Audio` /
`Transcript` / `Music` domain, provider-fit markers (`SttStreaming`,
`TtsIncrementalText`), and three new provider packages
(`@effect-uai/openai`, `@effect-uai/elevenlabs`, `@effect-uai/inworld`).
Bump dependencies, run typecheck, done.

If the user sees a 0.4-version compile error that looks like a rename
(`streamUntilComplete`, `nextStateFrom`, `matchType`, etc.), they're
actually on 0.2 or older — apply the **0.2 → 0.3** rules below.

---

## 0.2 → 0.3

### Required rewrites

#### Rename: `streamUntilComplete` → `onTurnComplete`

```ts
// Before
import { loop, stop, streamUntilComplete } from "@effect-uai/core/Loop"
stream.pipe(streamUntilComplete<State, ToolEvent>((turn) => ...))

// After
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
stream.pipe(onTurnComplete<State, ToolEvent>((turn) => ...))
```

Pure rename. Replace the import and the call site. No behavior change.

#### Rename + reshape: `Toolkit.nextStateFrom` → `Toolkit.continueWith`

```ts
// Before
const events = Toolkit.executeAll(tools, calls)
return Toolkit.nextStateFrom(events, (results) =>
  Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
)

// After (preferred — pipe form)
return Toolkit.executeAll(tools, calls).pipe(
  Toolkit.continueWith((results) =>
    Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
  ),
)
```

`continueWith` is `Function.dual`-curried, so both forms type-check.
Use the pipe form unless `events` is assembled from multiple streams
(e.g. the queue-based approval flow), in which case keep the
intermediate `const events =`.

#### Removed: `@effect-uai/core/Match` / `matchType`

```ts
// Before
import { matchType } from "@effect-uai/core/Match"
const handler = matchType<ToolEvent>()({ Intermediate: ..., Output: ..., ApprovalRequested: ... })

// After
import { Match } from "effect"
const handler = Match.discriminators("_tag")({ Intermediate: ..., Output: ..., ApprovalRequested: ... })
```

Use `Match.discriminatorsExhaustive` if exhaustiveness checking is
desired.

### Optional modernizations

#### Tool requirements via `R`

If the user has tools that need API keys, DB handles, or other
services, they can now flow them via Effect's `R` channel:

```ts
class WeatherApiKey extends Context.Service<WeatherApiKey, { key: string }>()(
  "app/WeatherApiKey",
) {}

const lookupWeather = Tool.make({
  name: "lookup_weather",
  inputSchema: ...,
  run: ({ city }) =>
    Effect.gen(function* () {
      const { key } = yield* WeatherApiKey
      return yield* fetchWeather(key, city)
    }),
})

// `executeAll` infers `Stream<ToolEvent, never, WeatherApiKey>`
const events = Toolkit.executeAll([lookupWeather], calls)
events.pipe(Stream.provide(Layer.succeed(WeatherApiKey, { key: "..." })))
```

Pre-0.3 users typically captured services in closures or threaded
them through manually. They can keep doing that — the `R` channel is
opt-in.

#### `Loop.loopWithState` for post-loop state

```ts
const { stream, state } = yield* loopWithState(initial, body)
yield* Stream.runDrain(stream)
const final = yield* SubscriptionRef.get(state)

// Or observe live:
SubscriptionRef.changes(state).pipe(Stream.runForEach(...))
```

Use when callers need to inspect state after the loop drains, or
observe state transitions concurrently. Otherwise stay on `loop`.

#### `Data.TaggedEnum` constructors

`ToolResult`, `ToolEvent`, and `Image*Source` are now tagged enums.
Existing `_tag` literal pattern-matching and `isValue` / `isFailure`
predicates still work; the new shape is purely additive.

```ts
ToolResult.Failure({ call_id, tool, kind: "denied" })  // constructor
ToolResult.$is("Failure")(result)                       // predicate
ToolResult.$match({ Value: ..., Failure: ... })(result) // matcher
```

### After-migration checklist

- [ ] No remaining `streamUntilComplete` references
- [ ] No remaining `nextStateFrom` references
- [ ] No imports from `@effect-uai/core/Match`
- [ ] `pnpm typecheck` clean
- [ ] Tests pass

---

## 0.1 → 0.2

(Not yet documented in this skill. See `packages/core/CHANGELOG.md`.)

---

## When this skill should _not_ run

- User is starting a new project — point them at `effect-uai-basic-usage`.
- User is on the latest version and asking how a specific API works —
  point them at the relevant feature skill (`effect-uai-tool-call-approval`,
  `effect-uai-streaming-tool-output`, etc.) or the docs.
- Breaking change is in user code, not in effect-uai — apply normal
  Effect debugging.

## See also

- [Migration guide for 0.8](https://effect-uai.betalyra.com/migrations/v0-8/)
- [Migration guide for 0.7](https://effect-uai.betalyra.com/migrations/v0-7/)
- [Migration guide for 0.6](https://effect-uai.betalyra.com/migrations/v0-6/)
- [Migration guide for 0.5](https://effect-uai.betalyra.com/migrations/v0-5/)
- [Migration guide for 0.4](https://effect-uai.betalyra.com/migrations/v0-4/)
- [Migration guide for 0.3](https://effect-uai.betalyra.com/migrations/v0-3/)
- `packages/core/CHANGELOG.md` for the per-PR record
- Feature skills under `skills/` for new-code patterns
