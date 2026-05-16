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

1. **State is a record you own.** History is `ReadonlyArray<Items.Item>`.
   Add whatever else your app needs (turn index, budget, tenant id,
   pendingPrompts, ...). The library never inspects it.
2. **One turn is a `Stream<TurnEvent>`.** Text deltas, reasoning, tool
   calls, usage updates, and the terminal `turn_complete` (carrying the
   assembled `Turn`) all flow through one typed stream.
3. **The loop is a pull-based combinator.** `loop((state) => Stream<Event<A, S>>)`
   threads state across iterations. Each body returns a stream that
   forwards values, then ends with `nextAfter(state)` to continue or
   `stop` to exit.
4. **Tools are typed Effects.** A `Tool` declares an input schema and a
   `run` returning an Effect. `Toolkit.executeAll(tools, calls)` returns
   a `Stream<ToolEvent>` so streaming tools can emit progress while
   structured outputs go back to the model.
5. **Providers are Layers.** `LanguageModel` is a single service; each
   provider package (`@effect-uai/responses`, `@effect-uai/anthropic`,
   `@effect-uai/google`) ships a `layer({ apiKey })` that implements it.
   The program shape stays identical across providers.

When the user asks for a "framework feature" (auto-retry, mid-stream
abort, pause/resume, streaming JSONL, multi-model voting, ...), the
answer is almost always "compose primitives in the loop body" — not
"reach for an integration." Recommend the appropriate recipe pattern
(see catalog below) instead of building wrapper layers.

## Install

```sh
pnpm add @effect-uai/core effect
# pick one or more providers:
pnpm add @effect-uai/responses   # OpenAI Responses + embeddings
pnpm add @effect-uai/anthropic   # Anthropic Claude
pnpm add @effect-uai/google      # Google Gemini language + embeddings
pnpm add @effect-uai/jina        # Jina embeddings (text + image, sparse, multivector)
pnpm add @effect-uai/elevenlabs  # ElevenLabs speech
```

The core package has no provider dependencies. Edge / browser builds
only pull in what's actually used.

For embedding (vectorize text or images, similarity ranking, RAG
retrieval primitive), reach for the `effect-uai-embedding` sub-skill —
`EmbeddingModel` is a parallel service to `LanguageModel`, with its
own provider layers and `embed` / `embedMany` helpers.

For speech and music, reach for the focused sub-skills:
`effect-uai-basic-transcription`, `effect-uai-streaming-transcription`,
`effect-uai-basic-speech-synthesis`, `effect-uai-streaming-synthesis`,
`effect-uai-voice-loop`, and `effect-uai-basic-music-generation`.

## Core modules (cheat sheet)

| Module                                  | What it gives you                                                                                                                                                                                                                          |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@effect-uai/core/Items`                | `Item` types (user/assistant messages, function calls, function call outputs, reasoning), helpers like `Items.userText`.                                                                                                                   |
| `@effect-uai/core/Turn`                 | `Turn`, `TurnEvent`, `Turn.functionCalls(turn)`, `Turn.assistantMessages(turn)`, `Turn.appendTurn(state, turn, items?)`, `Turn.toStructured(turn, format)`, `Turn.textDeltas`, `Turn.toSSE`, `Turn.toJSONL`, `Turn.asSSE`, `Turn.asJSONL`. |
| `@effect-uai/core/LanguageModel`        | `LanguageModel` service tag, `streamTurn(request)`, `turn(request)`, `CommonRequest` type.                                                                                                                                                 |
| `@effect-uai/core/Transcriber`          | `Transcriber` service tag, `transcribe(request)`, `streamTranscriptionFrom(request)`, sync file STT and streaming mic STT.                                                                                                                 |
| `@effect-uai/core/SpeechSynthesizer`    | `SpeechSynthesizer` service tag, `synthesize`, `streamSynthesis`, `streamSynthesisFrom` for finished-text and incremental-text TTS.                                                                                                        |
| `@effect-uai/core/MusicGenerator`       | `MusicGenerator` service tag, `generate`, `streamGeneration`, `streamGenerationFrom` for prompt-to-music workflows.                                                                                                                        |
| `@effect-uai/core/Loop`                 | `loop`, `nextAfter`, `nextAfterFold`, `stop`, `stopAfter`, `onTurnComplete`.                                                                                                                                                               |
| `@effect-uai/core/Tool`                 | `Tool.make`, `Tool.streaming`, `Tool.fromEffectSchema`, `Tool.toDescriptors`, `Tool.AnyKindTool`.                                                                                                                                          |
| `@effect-uai/core/Toolkit`              | `Toolkit.make`, `Toolkit.executeAll`, `Toolkit.outputEvents`, `Toolkit.outputEvent`, `Toolkit.continueWith`.                                                                                                                               |
| `@effect-uai/core/Outcome`              | `ToolResult` (`Value` / `Failure`), `toFunctionCallOutput`, `denied`, `cancelled`, `executionError`.                                                                                                                                       |
| `@effect-uai/core/ToolEvent`            | `ToolEvent` union (`ApprovalRequested` / `Intermediate` / `Output`), `isOutput`, `isIntermediate`, `isApprovalRequested`.                                                                                                                  |
| `@effect-uai/core/Resolvers`            | `fromApprovalMap`, `fromVerdictQueue` for human-in-the-loop tool approval.                                                                                                                                                                 |
| `@effect-uai/core/HistoryCheck`         | `findUnansweredCalls`, `cancelAllPending` for reconciling orphan tool calls between sessions.                                                                                                                                              |
| `@effect-uai/core/StructuredFormat`     | `StructuredFormat.fromEffectSchema(schema)`, `StructuredFormat.parseJson`, `StructuredFormat.decodeJsonLines`.                                                                                                                             |
| `@effect-uai/core/SSE`                  | Server-Sent Events codec: `SSE.fromBytes`, `SSE.toBytes`, `SSE.Event`.                                                                                                                                                                     |
| `@effect-uai/core/JSONL`                | JSONL codec: `JSONL.fromBytes`, `JSONL.parse(schema)`, `JSONL.toBytes(schema)`.                                                                                                                                                            |
| `@effect-uai/core/Lines`                | `Lines.lines` for re-framing a string stream as newline-terminated lines.                                                                                                                                                                  |
| `effect/Match`                          | Use `Match.discriminators("type")({ text_delta, ... })` (or `discriminatorsExhaustive`) to narrow `TurnEvent` and other `type`-tagged unions; standard Effect `Match` API.                                                                 |
| `@effect-uai/core/testing/MockProvider` | `MockProvider.layer(scriptedTurns)`, `MockProvider.layerWithRecorder`, `MockProvider.make` — for tests.                                                                                                                                    |

## Provider wiring

Every provider package exports `layer({ apiKey, ... })` that implements
the generic `LanguageModel` service. The standard wiring pattern:

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as responsesLayer } from "@effect-uai/responses"

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY")
    return responsesLayer({ apiKey })
  }),
)

const mainLayer = apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer))

Effect.runPromise(program.pipe(Effect.provide(mainLayer)))
```

For Anthropic: `import { layer as anthropicLayer } from "@effect-uai/anthropic"` + `ANTHROPIC_API_KEY`.
For Gemini: `import { layer as geminiLayer } from "@effect-uai/google"` + `GOOGLE_API_KEY`.

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
      Match.discriminators("type")({
        text_delta: ({ text }) => Effect.sync(() => process.stdout.write(text)),
      }),
      Match.orElse(() => Effect.void),
    ),
)
```

The terminal `turn_complete` event carries the assembled `Turn`, which
is what tool-using loops, structured-output validation, and history
appends are built on.

## The canonical agent loop

Almost every recipe is a variation of this shape:

```ts
import { Effect, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
import { toFunctionCallOutput } from "@effect-uai/core/Outcome"
import * as Tool from "@effect-uai/core/Tool"
import type { ToolEvent } from "@effect-uai/core/ToolEvent"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { Responses } from "@effect-uai/responses"

interface State {
  readonly history: ReadonlyArray<Items.Item>
}

const initial: State = {
  history: [Items.userText("What time is it in Lisbon?")],
}

const tools: ReadonlyArray<Tool.AnyKindTool> = [
  /* getCurrentTime, ... */
]
const descriptors = Tool.toDescriptors(tools)

export const conversation = pipe(
  initial,
  loop((state) =>
    Effect.gen(function* () {
      const oai = yield* Responses
      return oai
        .streamTurn({ history: state.history, model: "gpt-5.4-mini", tools: descriptors })
        .pipe(
          onTurnComplete<State, ToolEvent>((turn) =>
            Effect.sync(() => {
              const calls = Turn.functionCalls(turn)

              // No tool calls - assistant is done.
              if (calls.length === 0) return stop

              // Tool calls: execute and append outputs; loop again.
              return Toolkit.executeAll(tools, calls).pipe(
                Toolkit.continueWith((results) =>
                  Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
                ),
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

`Turn.appendTurn(state, turn, items)` is the canonical way to advance
state. It returns `{ ...state, history: [...state.history, ...turn.items, ...items] }`.

## Designing your loop body

When asked to add behavior, prefer adding to the loop body over
introducing wrapper services. The patterns below all live in one
`Effect.gen` block in the body, with no API surface change:

- **Persist state** between turns: write `state` to your DB at the top
  of each iteration. The library never inspects state.
- **Inject system policies**: gate calls with `fromApprovalMap` /
  `fromVerdictQueue` before `executeAll`.
- **Compact history**: when `state.history` exceeds a budget, run a
  separate `streamTurn` that summarizes earlier items, then return
  `nextAfter(Stream.empty, withSummary(state))`.
- **Track usage**: each `turn.usage` field is plain data; accumulate
  on state and emit your own metrics.
- **Branch on model output**: inspect `turn.items` (function calls,
  reasoning, refusals) before deciding what to do.
- **Add retries**: wrap `streamTurn` with `Stream.retry(schedule)` or
  use the model-retry recipe pattern (catchTags → retry → catchTag).
- **Multi-provider**: the body can choose which `LanguageModel` to use
  per iteration (e.g. for fallback / consensus).

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

When more than one applies (e.g. "agentic chat that retries on rate
limits and falls back to another provider"), compose them: the loop
body is just an Effect, and Effect composition is the integration
mechanism.

## Common gotchas

1. **Stream events vs. Turn items.** `TurnEvent` is the streaming
   delta union; `Turn.items` is the assembled list on `turn_complete`.
   Function calls live on `Turn.items`, not as standalone events. Use
   `Turn.functionCalls(turn)` once the turn completes.
2. **Function call outputs must be appended.** Every `function_call` the
   model emits requires a matching `function_call_output` in history
   before the next turn. `Toolkit.executeAll` + `toFunctionCallOutput`
   does this correctly. Synthesize cancelled / denied outputs (via
   `Outcome.denied` / `Outcome.cancelled`) when you don't run a tool.
3. **`Stream.retry` retries on every failure.** To retry only specific
   `AiError` tags, route them through a `Retryable` shim with
   `Stream.catchIf` (see `effect-uai-model-retry`). Otherwise non-
   retryable errors will retry too.
4. **Top-level structured output schema must be `type: object`.** All
   three providers reject bare arrays at the wire; wrap arrays in a
   `{ items: [...] }` object.
5. **Provider-specific options** (Responses `reasoning`, Anthropic
   `system` blocks, Gemini `safetySettings`) belong on the typed
   provider tag's request, not on `CommonRequest`. Yield the typed
   service (`yield* Responses`) when you need them.
6. **Tool input schemas need `type: object`.** A bare `Schema.Struct({})`
   serializes to no schema; the OpenAI Responses API rejects it. Add at
   least one field, or pick a different parameter shape.
7. **The loop never stops itself by default.** Long-lived agents (chat,
   queues, websocket-driven loops) terminate by external interruption
   (Ctrl-C, `Fiber.interrupt`, scope close). Don't add bespoke
   self-termination unless you mean it.

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
captures every `streamTurn` request — useful for asserting the model
saw the history you expected.

## Where to read more

- Repo: https://github.com/betalyra/effect-uai
- Docs: https://effect-uai.dev (or `docs/` in the repo)
- Recipes: `recipes/` in the repo — each recipe has an `index.ts`,
  `index.test.ts`, and (when interactive) a `run.ts` runner.
- Concepts: `docs/concepts/loop.md`, `docs/concepts/items-and-turns.md`,
  `docs/concepts/tools.md`, `docs/concepts/language-model.md`.
