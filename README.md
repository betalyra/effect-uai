# @effect-uai

_/ˈi.fɛkt ˈwaj/ — "effect-why"_

> **_Uai_** \\ wai \\ — Mineiro Portuguese, all-purpose interjection.

**Low-level primitives for building AI agents with [Effect](https://effect.website).**

`effect-uai` is not an agent framework. There is no runtime, no
orchestrator, no opinionated graph. It's a small set of typed,
streaming primitives - one turn, one tool call, one decision - that
you compose into whatever multi-turn flow your application needs.

Provider wire formats (OpenAI Responses, Anthropic, Google Gemini) are
normalized to a single `TurnEvent` union. State is your record. The
loop is your code.

## Status

⚠️ Early stage. APIs may shift. Use at your own risk.

## Why this exists

Most agent libraries decide _how_ your loop works - they pick the
state shape, the retry policy, the tool dispatch, the cancellation
model. When your real product needs something they didn't anticipate
(approval gates, mid-stream cancel, multi-provider fallback,
auto-compaction, replay), you fight the framework.

`effect-uai` inverts that. It owns the wire (HTTP, SSE parsing, event
normalization, schema validation). You own the policy (when to call a
tool, what to do with the result, when to stop, what to checkpoint).
The two meet at a `Stream<TurnEvent>` and a plain state record.

## Design principles

- 👀 **The loop is yours.** No hidden runtime - you write the multi-turn flow.
- 🧩 **Reuse Effect, don't reinvent.** Retries, errors, concurrency, cancellation, scheduling all come from Effect.
- 🌊 **Streaming first.** One primitive; blocking is just a drain.
- 🪞 **One normalized event shape.** OpenAI / Anthropic / Gemini all surface as the same `TurnEvent` union.
- ⚙️ **One turn is mechanical, many turns is policy.** The library owns the wire; you own the decision.
- 🎒 **State is whatever you want.** History, model, budget, retries - your shape.
- 🔄 **Models are values.** Swap providers per call, no special API.
- 🛡️ **Typed errors.** Every failure is tagged - match `RateLimited`, `Unavailable`, `Timeout` directly.
- 🛠️ **Tools as a stream of events.** Approvals, intermediate progress, terminal results - all on one channel.
- 📋 **Recipes over helpers.** Copy a snippet; don't import a tower of abstractions.

## Quick taste

```ts
import { Effect, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { streamTurn } from "@effect-uai/core/LanguageModel"

const haiku = Stream.runForEach(
  streamTurn({
    history: [Items.userText("Write a haiku about the sea.")],
    model: "gpt-5.4-mini",
  }),
  (event) =>
    event.type === "text_delta" ? Effect.sync(() => process.stdout.write(event.text)) : Effect.void,
)
```

That's one turn. For tools, approvals, multi-turn loops, and
cross-provider fallback, see the [docs](#docs--learn).

## Packages

| Package                                                       | What it is                                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| [`@effect-uai/core`](./packages/core)                         | The primitives: `Loop`, `LanguageModel`, `Tool`, `Toolkit`, `Items`, `Turn`, `Transcriber`, `SpeechSynthesizer`, `EmbeddingModel`, `MusicGenerator`. No provider deps. |
| [`@effect-uai/responses`](./packages/providers/responses)     | OpenAI Responses provider. Implements `LanguageModel` over OpenAI's `/v1/responses` endpoint.                                    |
| [`@effect-uai/anthropic`](./packages/providers/anthropic)     | Anthropic Messages provider, including extended thinking.                                                                        |
| [`@effect-uai/google`](./packages/providers/google)           | Google Gemini — language model, embeddings, speech (sync STT + TTS), and Lyria music generation.                                 |
| [`@effect-uai/openai`](./packages/providers/openai)           | OpenAI speech — `Transcriber` (sync + realtime WS) and `Synthesizer` (sync + chunked HTTP).                                      |
| [`@effect-uai/elevenlabs`](./packages/providers/elevenlabs)   | ElevenLabs speech — Scribe v2 Realtime STT and Flash v2.5 TTS with incremental-text-in WS.                                       |
| [`@effect-uai/inworld`](./packages/providers/inworld)         | Inworld speech — first-party STT/TTS plus router-style passthroughs (AssemblyAI / Soniox / Groq Whisper).                        |
| [`@effect-uai/jina`](./packages/providers/jina)               | Jina embeddings — dense, sparse (ELSER), and multivector (ColBERT-style) variants.                                               |

Each provider is its own package - edge / browser builds only pull in
what you actually use.

## Repo layout

```
.
├── packages/
│   ├── core/                  # @effect-uai/core - primitives, no provider deps
│   └── providers/
│       ├── responses/         # @effect-uai/responses - OpenAI Responses
│       ├── anthropic/         # @effect-uai/anthropic
│       ├── google/            # @effect-uai/google - Gemini + speech + Lyria
│       ├── openai/            # @effect-uai/openai - speech (STT/TTS)
│       ├── elevenlabs/        # @effect-uai/elevenlabs - speech
│       ├── inworld/           # @effect-uai/inworld - speech
│       └── jina/              # @effect-uai/jina - embeddings
├── recipes/                   # Working examples (type-checked, tested)
│   ├── basic-usage/           # Smallest end-to-end shape with one tool + one continuation
│   ├── tool-call-approval/    # HITL gating with HTTP- and queue-driven verdicts
│   ├── streaming-tool-output/ # Tool.streaming: sub-agent text + progress + terminal result
│   ├── streaming-structured-output/ # JSONL decoded one object at a time
│   ├── multi-model-fallback/  # Fall back across providers on RateLimited / Unavailable
│   ├── multi-model-compare/   # Fan one prompt out concurrently
│   ├── model-council/         # Models judge each other; winner streams back
│   ├── auto-compaction/       # Summarize history when token budget exceeded
│   ├── pause-resume/          # Checkpoint after each turn; resume via previousResponseId
│   ├── mid-stream-abort/      # Cancel the loop and the upstream HTTP request
│   ├── voice-loop/            # Streaming STT → LLM → TTS with stop-word interrupt
│   ├── basic-transcription/   # Sync STT across providers
│   ├── basic-speech-synthesis/ # Sync + chunked TTS across providers
│   ├── streaming-transcription/ # Live mic → transcript over WS
│   ├── streaming-synthesis/   # Incremental text-in TTS over WS
│   └── basic-music-generation/ # Lyria 3 with simple + weighted prompts
├── docs/                      # Source for the docs site (concepts, recipes, providers)
├── webpage/                   # Astro/Starlight site that renders docs/
└── experiments/               # Spikes and prototypes; not part of the published surface
```

A recipe folder typically contains:

- `index.ts` - the building blocks (tools, state, body), reusable in tests
- `run.ts` - a runnable demo that wires real providers
- `index.test.ts` - vitest tests against `MockProvider`
- `README.md` - the page that's mirrored in the docs site

## Docs / learn

Full docs: <https://effect-uai.betalyra.com>

Recommended reading order:

1. [One turn is a stream](https://effect-uai.betalyra.com/start/getting-started/) - the smallest provider-agnostic primitive.
2. [Basic usage](https://effect-uai.betalyra.com/recipes/basic-usage/) - the core agent harness: state, stream, tools, continuation.
3. [The loop primitive](https://effect-uai.betalyra.com/concepts/loop/) - what `loop` is, its shape, and `streamUntilComplete`.
4. [Items and turns](https://effect-uai.betalyra.com/concepts/items-and-turns/) - the conversation as a flat list, the assembled turn, the event stream.
5. [Tools and toolkits](https://effect-uai.betalyra.com/concepts/tools/) - `Tool.make`, `Tool.streaming`, approval planners, `ToolEvent`.

Then dip into recipes for whatever pattern you need.

## Local development

```bash
pnpm install
pnpm test          # vitest run across all workspaces
pnpm typecheck     # tsc --noEmit
```

To run a recipe end-to-end against real providers:

```bash
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-usage/run.ts
```

## License

MIT - see [LICENSE](./LICENSE).
