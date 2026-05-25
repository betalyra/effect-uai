# @effect-uai/core

Low-level primitives for building AI agents with [Effect](https://effect.website).

The core thesis: **the user owns the loop**. State is a plain record;
`Loop` events control iteration; the body is a `Stream`. There is no
agent runtime, no orchestrator, no provider lock-in.

This package exposes:

- **Domain types** - `Items`, `Turn`, `AiError`
- **Provider contract** - `LanguageModel`
- **Loop primitive** - `Loop` (`loop`, `loopWithState`, `value`, `next`, `stop`, `nextAfter`, `emitValues`, `emitNext`, `onTurnComplete`)
- **Tools** - `Tool`, `Toolkit`, `Outcome`, `ToolEvent`, `Resolvers`, `HistoryCheck`
- **Streaming codecs** - `SSE`, `JSONL`, `Lines`
- **Structured output** - `StructuredFormat`
- **Observability** - `Metrics`
- **Testing** - `testing/MockProvider`

No provider deps. Pair with one of:

- [`@effect-uai/responses`](https://www.npmjs.com/package/@effect-uai/responses) - OpenAI Responses API
- [`@effect-uai/anthropic`](https://www.npmjs.com/package/@effect-uai/anthropic) - Anthropic Messages
- [`@effect-uai/google`](https://www.npmjs.com/package/@effect-uai/google) - Google Gemini

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
