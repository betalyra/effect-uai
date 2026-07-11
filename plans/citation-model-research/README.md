# Citation-model research notes

Reference material gathered while designing the unified citation + streaming
model for `DeepResearch` (see Appendix A in `../deep-research.md`). Captured
2026-07.

- [01-codebase-native-search-citations.md](01-codebase-native-search-citations.md): how the repo models and streams native web-search tool citations today (Responses / Anthropic / Google, the `ProviderTool` abstraction). Bottom line: only OpenAI `url_citation` survives, only on the final `Turn`; nothing streams.
- [02-codebase-websearch-and-grounding.md](02-codebase-websearch-and-grounding.md): the `WebSearch` capability (`SearchResult`/`WebSearchTool`) and the native-grounding recipe decisions. `WebSearch` emits no citation objects; `Items.Annotation` is the one canonical citation type.
- [03-wire-four-providers-streaming.md](03-wire-four-providers-streaming.md): deep wire-level streaming shapes for OpenAI, Anthropic, Gemini (two surfaces), Perplexity.
- [04-wire-all-providers-matrix.md](04-wire-all-providers-matrix.md): broad matrix across all Category-A (server-side tool) and Category-B (standalone search) providers; the 3-style citation taxonomy.
