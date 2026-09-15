# @effect-uai/core

Low-level primitives for building AI agents with [Effect](https://effect.website).

The core thesis: **the user owns the loop**. State is a plain record;
`Loop` events control iteration; the body is a `Stream`. There is no
agent runtime, no orchestrator, no provider lock-in.

## Capabilities

Each is a service tag that provider packages implement, so switching
provider is swapping a Layer:

- **Language models** - `LanguageModel`, with `Loop`, `Items`, `Turn`,
  `Tool`, `Toolkit` and `StructuredFormat`
- **Speech** - `Transcriber` (file and streaming STT),
  `SpeechSynthesizer` (finished and incremental TTS)
- **Realtime** - `RealtimeSession`: a live conversation with a realtime
  model, voice both ways and camera frames where the provider takes them
- **Embeddings and retrieval** - `EmbeddingModel`, `Reranker`,
  `Chunker`, `Tokenizer`
- **Images and music** - `ImageGenerator`, `MusicGenerator`
- **Web** - `WebSearch`, `WebRead`, `DeepResearch`, `Browser`
- **Runtime** - `Sandbox` for running model-written code
- **Messaging** - `Messenger`: the agent as a Telegram, Discord or
  Slack bot

Plus the pieces underneath: `AiError` (typed failures across every
capability), streaming codecs (`SSE`, `JSONL`, `Lines`), `Settle` for
acting on a pause in a stream of arrivals, `Metrics`, and a mock layer
per capability under `testing/`.

No provider deps. Pair with one or more provider packages:
[`@effect-uai/openai`](https://www.npmjs.com/package/@effect-uai/openai),
[`@effect-uai/anthropic`](https://www.npmjs.com/package/@effect-uai/anthropic),
[`@effect-uai/google`](https://www.npmjs.com/package/@effect-uai/google),
[`@effect-uai/mistral`](https://www.npmjs.com/package/@effect-uai/mistral)
and [the rest](https://effect-uai.betalyra.com/providers/).

## Install

```sh
pnpm add @effect-uai/core effect
```

ESM-only. Requires `effect@4.x` as a peer.

## Docs

Full docs: <https://effect-uai.betalyra.com>

Start with [One turn is a stream](https://effect-uai.betalyra.com/start/getting-started/)
and then [Basic usage](https://effect-uai.betalyra.com/recipes/basic-usage/).

## License

MIT
