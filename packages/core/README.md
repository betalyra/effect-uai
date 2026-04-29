# @betalyra/effect-uai-core

Low-level primitives for building AI agents with [Effect](https://effect.website).

The core package exposes:

- **Domain types** - `Items`, `Turn`, `AiError`
- **Provider contract** - `LanguageModel`
- **Loop primitive** - `Loop` (`loop`, `value`, `next`, `stop`, `nextAfter`, `stopAfter`)
- **Tools** - `Tool`, `Toolkit`
- **Streaming codecs** - `SSE`, `JSONL`
- **Observability** - `Metrics`
- **Testing** - `testing/MockProvider`

The core thesis: the user owns the loop. State is a plain record;
`Loop` events control iteration; the body is a `Stream`.
