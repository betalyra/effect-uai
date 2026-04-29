# @betalyra/effect-uai-core

Low-level primitives for building AI agents with [Effect](https://effect.website).

The core package exposes:

- **Domain types** — `Items`, `Turn`, `AiError`
- **Provider contract** — `LanguageModel`
- **Loop primitive** — `Loop` (`loop`, `next`, `stop`, `Decision<S>`)
- **Conversation helpers** — `Conversation` (cursor, advance, stop)
- **Tools** — `Tool`, `Toolkit`
- **Streaming codecs** — `SSE`, `JSONL`
- **Observability** — `Metrics`
- **Testing** — `testing/MockProvider`

The core thesis: the user owns the loop. State is a plain record;
`Decision<S>` controls iteration; the body is a `Stream`.
