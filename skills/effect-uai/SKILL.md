---
name: effect-uai
description: Use when building AI agents and AI media workflows with effect-uai (Effect-based primitives for agent loops, tools, streaming, structured output, embeddings, speech, and music generation). Covers design philosophy, core primitives, provider wiring, and recipe skills for retry, fallback, tool approval, embeddings, transcription, speech synthesis, voice loops, music generation, SSE/JSONL, and more.
license: MIT
---

# effect-uai

Low-level Effect primitives for building AI agents as ordinary programs.
The library does not own your control flow; it gives you the pieces and
gets out of the way.

## Design philosophy

Use this mental model when writing or recommending code:

1. **State is a record you own.** History is `ReadonlyArray<Items.HistoryItem>`.
   Add whatever else your app needs (turn index, budget, tenant id,
   pendingPrompts, ...). The library never inspects it.
2. **One turn is a `Stream<TurnEvent>`.** Text deltas, reasoning, tool
   calls, usage updates, and the terminal `TurnComplete` (carrying the
   assembled `Turn`) all flow through one typed stream.
3. **The loop is a pull-based combinator.** `loop((state) => Stream<Step<A, S>>)`
   threads state across iterations. Each body returns a stream that
   forwards values, then ends with `Loop.next(state)` to continue or
   `Loop.stop()` / `Loop.stop(state)` to exit.
4. **Tools are typed Effects.** A `Tool` declares an input schema and a
   `run` returning an Effect. `Toolkit.run(tools, calls)` returns
   a `Stream<ToolEvent>` so streaming tools can emit progress while
   structured outputs go back to the model.
5. **Providers are Layers.** `LanguageModel` is a single service; each
   provider package (`@effect-uai/responses`, `@effect-uai/anthropic`,
   `@effect-uai/google`) ships a `layer({ apiKey })` that implements it.
   The program shape stays identical across providers.

When the user asks for a "framework feature" (auto-retry, mid-stream
abort, pause/resume, streaming JSONL, multi-model voting, ...), the
answer is almost always "compose primitives in the loop body", not
"reach for an integration." Recommend the appropriate recipe pattern
(see catalog below) instead of building wrapper layers.

## Install

```sh
pnpm add @effect-uai/core effect
# pick one or more providers:
pnpm add @effect-uai/responses     # OpenAI Responses + embeddings
pnpm add @effect-uai/anthropic     # Anthropic Claude
pnpm add @effect-uai/google        # Google Gemini language + embeddings + speech + music
pnpm add @effect-uai/jina          # Jina embeddings (text + image, sparse, multivector)
pnpm add @effect-uai/openai        # OpenAI speech (TTS + STT, separate from Responses)
pnpm add @effect-uai/elevenlabs    # ElevenLabs speech (TTS + STT, multi-speaker dialogue)
pnpm add @effect-uai/inworld       # Inworld speech (TTS + STT)
pnpm add @effect-uai/microsandbox  # Local Firecracker microVMs for sandboxed code
pnpm add @effect-uai/deno          # Hosted Firecracker microVMs on Deno Deploy
```

The core package has no provider dependencies. Edge / browser builds
only pull in what's actually used.

For embedding (vectorize text or images, similarity ranking, RAG
retrieval primitive), reach for the `effect-uai-embedding` sub-skill.
`EmbeddingModel` is a parallel service to `LanguageModel`, with its
own provider layers and `embed` / `embedMany` helpers.

For speech and music, reach for the focused sub-skills:
`effect-uai-basic-transcription`, `effect-uai-streaming-transcription`,
`effect-uai-basic-speech-synthesis`, `effect-uai-streaming-synthesis`,
`effect-uai-voice-loop`, and `effect-uai-basic-music-generation`.

For running untrusted code or LLM-generated scripts inside a microVM,
reach for `effect-uai-sandbox-basics`. The `Sandbox` capability in
`@effect-uai/core/Sandbox` is implemented by `@effect-uai/microsandbox`
(local Firecracker) and `@effect-uai/deno` (hosted on Deno Deploy).

For migrating an existing codebase to v0.6 (the function-call / tool-call
naming sweep), reach for `effect-uai-migrate`.

## Core modules (cheat sheet)

| Module                                  | What it gives you                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@effect-uai/core/Items`                | `HistoryItem` types (user/assistant messages, tool calls, tool call outputs, reasoning), helpers like `Items.userText`, `Items.toolCallOutput`, predicates `Items.isToolCall`, `Items.isToolCallOutput`.                                                                                                                    |
| `@effect-uai/core/Turn`                 | `Turn`, `TurnEvent`, `Turn.getToolCalls(turn)`, `Turn.assistantMessages(turn)`, `Turn.assistantText(turn)`, `Turn.assistantTexts(turn)`, `Turn.appendToHistory(state, turn, items?)`, `Turn.decodeStructured(turn, format)`, `Turn.textDeltas`, `Turn.toSSE`, `Turn.toJSONL`, `Turn.asSSE`, `Turn.asJSONL`.                 |
| `@effect-uai/core/LanguageModel`        | `LanguageModel` service tag, `streamTurn(request)`, `turn(request)`, `CommonRequest` type, `turnFromStream(streamTurn)` for hand-rolled services.                                                                                                                                                                           |
| `@effect-uai/core/Retry`                | `Retry.stream(schedule)`, `Retry.effect(schedule)`, `Retry.Retryable`, `Retry.isRetryable`. Retries the retryable subset of `AiError` (RateLimited \| Unavailable \| Timeout); works for any model service.                                                                                                                 |
| `@effect-uai/core/Transcriber`          | `Transcriber` service tag, `transcribe(request)`, `streamTranscriptionFrom(request)`. Sync file STT and streaming mic STT.                                                                                                                                                                                                  |
| `@effect-uai/core/SpeechSynthesizer`    | `SpeechSynthesizer` service tag, `synthesize`, `streamSynthesis`, `streamSynthesisFrom` for finished-text and incremental-text TTS. New in 0.6: `synthesizeDialogue`, `streamSynthesizeDialogue` (gated by the `MultiSpeakerTts` capability marker); `pronunciations` on `CommonSynthesizeRequest`.                         |
| `@effect-uai/core/MusicGenerator`       | `MusicGenerator` service tag, `generate`, `streamGeneration`, `streamGenerationFrom` for prompt-to-music workflows.                                                                                                                                                                                                         |
| `@effect-uai/core/Loop`                 | `loop`, `loopOver`, `loopWithState`, `value(a)`, `next(state)`, `stop()` / `stop(state)`, `onTurnComplete`. `Step<A, S>` is the event type. The v0.5 `nextAfter` / `stopAfter` / `stopWithAfter` / `stopEvent` / `nextAfterFold` helpers were removed in 0.6; compose with `Stream.concat` instead.                         |
| `@effect-uai/core/Tool`                 | `Tool.make`, `Tool.streaming`, `Tool.fromEffectSchema`, `Tool.fromStandardSchema`, `Tool.toDescriptors`, `Tool.AnyTool` (the v0.5 `AnyKindTool` was renamed).                                                                                                                                                               |
| `@effect-uai/core/Toolkit`              | `Toolkit.run(tools, calls)`, `Toolkit.continueWithResults(build)`, `Toolkit.appendToolResults(state, turn)`, `Toolkit.collectResults(stream)`. The v0.5 `Toolkit.make(...)` wrapper is gone, pass arrays directly to `Tool.toDescriptors([...])` and `Toolkit.run`.                                                         |
| `@effect-uai/core/ToolResult`           | `ToolResult` (`Ok` / `Failure`), `ToolResult.isOk`, `ToolResult.isFailure`, `toToolCallOutput`, `failed`, `denied`, `cancelled`, `executionError`. (Renamed from `@effect-uai/core/Outcome` in 0.6.)                                                                                                                        |
| `@effect-uai/core/ToolEvent`            | `ToolEvent` union (`ApprovalRequested` / `Progress` / `Output`), `isOutput`, `isProgress`, `isApprovalRequested`. (`Intermediate` was renamed to `Progress` in 0.6.)                                                                                                                                                        |
| `@effect-uai/core/Approval`             | `Approval.fromMap`, `Approval.fromQueue`, `ApprovalDecision` (`Approved` / `Rejected`) for human-in-the-loop tool approval. The queue helper surfaces pending requests as `approvalRequests`. (Renamed from `@effect-uai/core/Resolvers` in 0.6; `fromApprovalMap` / `fromVerdictQueue` / `ToolCallDecision` / `announce`.) |
| `@effect-uai/core/Sandbox`              | `SandboxService` capability for running untrusted code or LLM scripts in an isolated microVM. `create` / `exec` / `execStream`, plus `SandboxImage`, `SandboxNetwork`, `Memory`. Two providers: `@effect-uai/microsandbox` (local) and `@effect-uai/deno` (hosted).                                                         |
| `@effect-uai/core/HistoryCheck`         | `findUnansweredCalls`, `cancelAllPending` for reconciling orphan tool calls between sessions.                                                                                                                                                                                                                               |
| `@effect-uai/core/StructuredFormat`     | `StructuredFormat.fromEffectSchema(schema)`, `StructuredFormat.parseJson`, `StructuredFormat.decodeJsonLines`, `decodeJsonLinesRecoverable`.                                                                                                                                                                                |
| `@effect-uai/core/SSE`                  | Server-Sent Events codec: `SSE.fromBytes`, `SSE.toBytes`, `SSE.Event`.                                                                                                                                                                                                                                                      |
| `@effect-uai/core/JSONL`                | JSONL codec: `JSONL.fromBytes`, `JSONL.parse(schema)`, `JSONL.toBytes(schema)`.                                                                                                                                                                                                                                             |
| `@effect-uai/core/Lines`                | `Lines.lines` for re-framing a string stream as newline-terminated lines.                                                                                                                                                                                                                                                   |
| `effect/Match`                          | `Match.discriminators("_tag")({ TextDelta, ... })` for `TurnEvent` / `ToolEvent` (both `_tag`-tagged via `Data.taggedEnum`); also `TurnEvent.$is(...)` / `TurnEvent.$match(...)` constructors. `Match.discriminators("type")` for domain `HistoryItem` types and provider wire shapes.                                      |
| `@effect-uai/core/testing/MockProvider` | `MockProvider.layer(scriptedTurns)`, `MockProvider.layerWithRecorder`, `MockProvider.make` for tests.                                                                                                                                                                                                                       |

## Provider wiring

Every provider package exports a namespaced `layer({ apiKey, ... })`
that implements the generic `LanguageModel` service. The standard
wiring pattern:

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as responsesLayer } from "@effect-uai/responses/Responses"

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey })
  }),
)

const mainLayer = apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer))

Effect.runPromise(program.pipe(Effect.provide(mainLayer)))
```

For Anthropic: `import { layer as anthropicLayer } from "@effect-uai/anthropic/Anthropic"` + `ANTHROPIC_API_KEY`.
For Gemini: `import { layer as geminiLayer } from "@effect-uai/google/Gemini"` + `GOOGLE_API_KEY`.

Each provider also re-exports a typed service tag (`Responses`,
`Anthropic`, `Gemini`) for code that wants the provider-specific
request shape (e.g. `reasoning: { effort: "low" }` on Responses).
For provider-agnostic code, use the generic `LanguageModel` service.

## One turn is a stream

The smallest example: stream one model response and print text deltas.

```ts
import { Effect, Match, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import { streamTurn } from "@effect-uai/core/LanguageModel"

const program = Stream.runForEach(
  streamTurn({
    history: [Items.userText("Write a haiku about the sea.")],
    model: "gpt-5.4-mini",
  }),
  (event) =>
    Match.value(event).pipe(
      Match.discriminators("_tag")({
        TextDelta: ({ text }) => Effect.sync(() => process.stdout.write(text)),
      }),
      Match.orElse(() => Effect.void),
    ),
)
```

The terminal `TurnComplete` event carries the assembled `Turn`, which
is what tool-using loops, structured-output validation, and history
appends are built on.

## The canonical agent loop

Almost every recipe is a variation of this shape:

```ts
import { Effect, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { Responses } from "@effect-uai/responses/Responses"

interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
}

const initial: State = {
  history: [Items.userText("What time is it in Lisbon?")],
}

const allTools: ReadonlyArray<Tool.AnyTool> = [
  /* getCurrentTime, ... */
]
const tools = Tool.toDescriptors(allTools)

export const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses
      return oai.streamTurn({ history: state.history, model: "gpt-5.4-mini", tools }).pipe(
        onTurnComplete((turn) =>
          Effect.sync(() => {
            const calls = Turn.getToolCalls(turn)

            // No tool calls: assistant is done.
            if (calls.length === 0) return stop()

            // Tool calls: execute, append outputs, loop again.
            return Toolkit.run(allTools, calls).pipe(
              Toolkit.continueWithResults(Toolkit.appendToolResults(state, turn)),
            )
          }),
        ),
      )
    }),
  ),
)
```

Read the body in plain English: "stream a turn. When it completes, if
the model asked for tools, run them and continue with the appended
history. Otherwise, stop." Every variation in the recipe catalog is a
small change to this body.

`Turn.appendToHistory(state, turn, items)` is the canonical way to advance
state. It returns `{ ...state, history: [...state.history, ...turn.items, ...items] }`.
`Toolkit.appendToolResults(state, turn)` is shorthand for the common case
of converting `ToolResult`s with `toToolCallOutput` and folding them in.

## Designing your loop body

When asked to add behavior, prefer adding to the loop body over
introducing wrapper services. The patterns below all live in one
`Effect.gen` block in the body, with no API surface change:

- **Persist state** between turns: write `state` to your DB at the top
  of each iteration. The library never inspects state.
- **Inject system policies**: gate calls with `Approval.fromMap` /
  `Approval.fromQueue` before `Toolkit.run`.
- **Compact history**: when `state.history` exceeds a budget, run a
  separate `streamTurn` that summarizes earlier items, then return
  `Loop.next(withSummary(state))`.
- **Track usage**: each `turn.usage` field is plain data; accumulate
  on state and emit your own metrics.
- **Branch on model output**: inspect `turn.items` (tool calls,
  reasoning, refusals) before deciding what to do.
- **Add retries**: wrap `streamTurn` with `Retry.stream(schedule)` (or
  `Stream.retry`); see the model-retry recipe for tag-aware retry.
- **Multi-provider**: the body can choose which `LanguageModel` to use
  per iteration (e.g. for fallback / consensus).
- **Run untrusted code**: yield a `SandboxService` inside the body,
  `create` a microVM, `exec` the script, and feed `stderr` back into
  the next turn. See `effect-uai-sandbox-basics` and the
  `sandbox-code-interpreter` recipe.

## Recipe catalog (use the right sub-skill)

For each pattern there is a dedicated `effect-uai-<recipe>` skill with
the loop body, the gotchas, and a runnable example. Reach for the
matching skill when the user describes the scenario:

| Scenario                                                                                | Skill                                    |
| --------------------------------------------------------------------------------------- | ---------------------------------------- |
| First-time agent: tools, streaming, multi-turn loop                                     | `effect-uai-basic-usage`                 |
| Validate a typed JSON object from the model (one-shot, server-enforced schema)          | `effect-uai-structured-output`           |
| Stream typed JSONL objects as the model writes them                                     | `effect-uai-streaming-structured-output` |
| Pause sensitive tool calls for a human verdict before executing                         | `effect-uai-tool-call-approval`          |
| Show inner tool work (sub-agent, progress bar) while returning one clean output         | `effect-uai-streaming-tool-output`       |
| Drive a long-lived chat from a queue; debounce typing bursts; check input between turns | `effect-uai-agentic-loop`                |
| Retry rate-limited / transient provider failures with exponential backoff               | `effect-uai-model-retry`                 |
| Fall back to another provider when the primary is rate-limited or unavailable           | `effect-uai-multi-model-fallback`        |
| Let a cheap model escalate hard questions to a stronger model via a tool call           | `effect-uai-model-escalation`            |
| Summarize history when it gets too long; keep going                                     | `effect-uai-auto-compaction`             |
| Pause the loop between turns and resume later (no provider call held open)              | `effect-uai-pause-resume`                |
| Cancel an in-flight turn through stream interruption + scope cleanup                    | `effect-uai-mid-stream-abort`            |
| Send the same prompt to multiple providers; isolate per-member failures                 | `effect-uai-multi-model-compare`         |
| Have models judge each other and emit a winner                                          | `effect-uai-model-council`               |
| Project the loop's output as Server-Sent Events or JSONL on the wire                    | `effect-uai-modify-output-stream`        |
| Embed text or images, semantic / cross-modal / multivector retrieval, RAG primitive     | `effect-uai-embedding`                   |
| Transcribe finished audio files, optionally with word timestamps                        | `effect-uai-basic-transcription`         |
| Build live captions from a browser mic or realtime STT stream                           | `effect-uai-streaming-transcription`     |
| Turn finished text into an audio file or chunked playback                               | `effect-uai-basic-speech-synthesis`      |
| Pipe incremental text / LLM deltas into low-latency TTS                                 | `effect-uai-streaming-synthesis`         |
| Compose live STT -> LLM -> streaming TTS with turn queueing and stop-word interrupt     | `effect-uai-voice-loop`                  |
| Generate music clips from simple or weighted prompts                                    | `effect-uai-basic-music-generation`      |
| Run untrusted code or LLM-generated scripts inside an isolated Firecracker microVM      | `effect-uai-sandbox-basics`              |
| Migrate an existing codebase from v0.5 to v0.6 (function-call to tool-call rename)      | `effect-uai-migrate`                     |

When more than one applies (e.g. "agentic chat that retries on rate
limits and falls back to another provider"), compose them: the loop
body is just an Effect, and Effect composition is the integration
mechanism.

## Common gotchas

1. **Stream events vs. Turn items.** `TurnEvent` is the streaming
   delta union; `Turn.items` is the assembled list on `TurnComplete`.
   Tool calls live on `Turn.items`, not as standalone events. Use
   `Turn.getToolCalls(turn)` once the turn completes.
2. **Tool call outputs must be appended.** Every `ToolCall` the model
   emits requires a matching `ToolCallOutput` in history before the
   next turn. `Toolkit.run` + `toToolCallOutput` does this correctly
   (and `Toolkit.appendToolResults` bundles both steps). Synthesize
   cancelled / denied outputs (via `ToolResult.denied` /
   `ToolResult.cancelled`) when you don't run a tool.
3. **Source-level vs. wire-format naming (0.6 only matters at the source).**
   v0.6 renamed every public name from "function call" to "tool call"
   (`Items.FunctionCall` -> `Items.ToolCall`, etc.). The wire format
   is unchanged: providers still send `function_call` and
   `function_call_output` payloads. You only need to update imports
   and identifiers; no payload migration.
4. **`Stream.retry` retries on every failure.** To retry only the
   retryable `AiError` subset (`RateLimited` / `Unavailable` / `Timeout`),
   use `Retry.stream(schedule)` / `Retry.effect(schedule)` from
   `@effect-uai/core/Retry` (see `effect-uai-model-retry`). Plain
   `Stream.retry` will retry non-retryable errors too.
5. **Top-level structured output schema must be `type: object`.** All
   providers reject bare arrays at the wire; wrap arrays in a
   `{ items: [...] }` object.
6. **Provider-specific options** (Responses `reasoning`, Anthropic
   `system` blocks, Gemini `safetySettings`) belong on the typed
   provider tag's request, not on `CommonRequest`. Yield the typed
   service (`yield* Responses`) when you need them.
7. **Tool input schemas need `type: object`.** A bare `Schema.Struct({})`
   serializes to no schema; the OpenAI Responses API rejects it. Add at
   least one field, or pick a different parameter shape.
8. **`Loop.stop` is a function in 0.6.** Return `stop()` for "end the
   loop", `stop(state)` for "end and surface final state". The v0.5
   bare `stop` constant and `stopWith(state)` helper are gone.
9. **The loop never stops itself by default.** Long-lived agents (chat,
   queues, websocket-driven loops) terminate by external interruption
   (Ctrl-C, `Fiber.interrupt`, scope close). Don't add bespoke
   self-termination unless you mean it.
10. **Sandboxes are scope-bound.** Wrap `Sandbox.create(...)` in
    `Effect.scoped` (or compose into a `Scope`d effect) so the microVM
    is torn down on completion or interruption. Leaking sandboxes
    means leaking billable infra on hosted providers.

## Testing

Use `MockProvider.layer(scriptedTurns)` to drive a loop without hitting
a real provider:

```ts
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"

const finalTurn: Turn.Turn = {
  stop_reason: "stop",
  usage: { input_tokens: 8, output_tokens: 4, total_tokens: 12 },
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "ok" }],
    },
  ],
}

await Effect.runPromise(
  Stream.runCollect(conversation).pipe(Effect.provide(MockProvider.layer([finalTurn]))),
)
```

`MockProvider.layerWithRecorder` returns a layer + a recorder that
captures every `streamTurn` request, useful for asserting the model
saw the history you expected.

## Where to read more

- Repo: https://github.com/betalyra/effect-uai
- Docs: https://effect-uai.betalyra.com (or `docs/` in the repo)
- Recipes: `recipes/` in the repo. Each recipe has an `index.ts`,
  `index.test.ts`, and (when interactive) a `run.ts` runner.
- Concepts: `docs/concepts/loop.md`, `docs/concepts/items-and-turns.md`,
  `docs/concepts/tools.md`, `docs/concepts/language-model.md`.
