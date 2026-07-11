# Codebase: WebSearch capability + native-grounding decisions (as of 2026-07)

> Research note for the deep-research citation-model appendix.

## Key finding

There is **no `plans/native-grounding.md`**. Native grounding exists only as a
recipe at `recipes/native-grounding/` (README.md, recipe.ts, app.ts, runners).
The decisions about the "Phase-2 citation payoff" and reusing `Items.Annotation`
live in `plans/deep-research.md`, which names them as deferred from
`native-grounding`. WebSearch itself deliberately produces **no**
citation-shaped output; the two systems are decoupled by design.

## 1. WebSearch capability

`SearchResult`, `packages/core/src/web-search/WebSearch.ts:85-108` (flat record,
not a tagged union; providers differ by which fields are present):
```ts
export type SearchResult = {
  readonly url: string            // canonical URL, always present
  readonly title?: string
  readonly snippet?: string       // primary short excerpt
  readonly publishedDate?: DateTime.DateTime
  readonly score?: number         // only ranking providers (Exa, Tavily)
  readonly raw: unknown           // provider-native result, never lossy
}
```

`SearchResponse`, `WebSearch.ts:110-121`: `{ results: ReadonlyArray<SearchResult>, raw: unknown }`. Cost / usage deliberately not modeled (deferred to `plans/usage-tracking.md`). Service tag `WebSearch` (`:142-144`) exposes one op `search`; helper `search()` `:147-151`. Request `CommonSearchRequest` `:43-72`; `SearchRecency` `:23`.

How `WebSearchTool` feeds a model, `packages/core/src/web-search/WebSearchTool.ts`:
- Model-facing args are narrow (`:14-17`): only `query` + optional `recency`. `maxResults`, `includeDomains`, `excludeDomains` are app policy pinned on the constructor (`:32-52`, `:73-80`), not exposed to the model.
- The model consumes rendered **text**, not structured results. `defaultRender` (`:22-30`) turns `SearchResult[]` into a numbered `title / url / snippet` string. Tool `Output` type is `string` (`:75`). `run` (`:90-110`) calls `search(...)`, maps to `render(r.results)`, wrapped in a `withSpan` trace.

Does WebSearch produce anything citation-shaped? **No.** `SearchResult` carries `url` + `title` (citation ingredients) but WebSearch never emits `Items.Annotation` / `UrlCitation`. The tool flattens results to a plain string; no offset-indexed citation object, no link to `Items.ts`. `plans/search.md:388-393` makes this an explicit non-goal: "wrapping provider-native server-side search tools ... A native-tool passthrough could be a separate later addition."

## 2. Native grounding: the decisions

Where it lives: recipe `recipes/native-grounding/{README.md,recipe.ts,app.ts}`. Plan-level decisions in `plans/deep-research.md` and `plans/search.md`.

Decision A: provider-hosted tool, citations attached server-side. `recipes/native-grounding/README.md:8-9`: "Hand the model a provider-hosted tool and it searches on its own side, then answers with citations attached." `recipe.ts:1-13`: the hosted tool executes inside the provider turn and never shows up as a local tool call; the loop stops once the grounded answer arrives. Tool is provider-specific (`Gemini.googleSearchTool` / `Anthropic.webSearchTool` / `Responses.webSearchTool`); mismatched provider -> `AiError.Unsupported`. Tool has no `run` and is withheld on the final round (`recipe.ts:71`, `:79`).

Decision B: the "Phase-2 citation payoff" reuses `Items.Annotation`. `plans/deep-research.md:145-149`: "`Items.Annotation` (`UrlCitation` `{type,url,title,start_index,end_index}` / ...) already exists and already covers OpenAI's `annotations[]` and Perplexity's `citations[]` + `search_results[]`. Reuse it. This is the deferred Phase-2 citation payoff from `native-grounding`: research agents return structured citations and we have the type." Phasing step 1 (`:359-363`): "Reuse `Items.Annotation`, `Items.Usage`, `StructuredFormat`." The decision: do not invent a new citation type.

Decision C: streaming citations. No streaming citation event exists or is planned. Grep of `Turn.ts`, `LanguageModel.ts`, `Loop.ts` for `annotation|citation` returns nothing; there is no citation `TurnEvent`/delta. Citations ride only on the completed `OutputText.annotations` block. The deep-research `ResearchEvent` stream (`deep-research.md:137-142`) carries `ReasoningDelta`/`SearchStarted`/`TextDelta`/`Report`; citations arrive only in the terminal `Report`, not streamed.

## 3. Every reference to Annotation / UrlCitation / citation / annotations

Type definitions `packages/core/src/domain/Items.ts`:
- `:29-31` doc comment (source / citation pointers on `output_text`, mirrors OpenAI Responses).
- `:34-41` `UrlCitation` `{type:"url_citation", url, start_index, end_index, title}`.
- `:43-48` `FileCitation` (`file_id`, `index`). `:50-57` `ContainerFileCitation` (`container_id`, `file_id`, `start_index`, `end_index`). `:59-64` `FilePath` (`file_id`, `index`).
- `:66-67` `Annotation = Union([UrlCitation, FileCitation, ContainerFileCitation, FilePath])`.
- `:69-72` guards `isUrlCitation` etc. `:74-79` `OutputText.annotations` (the only attach point).

Responses provider wire codec `packages/providers/responses/src/codec.ts`:
- `:10-16` `WireUrlCitation`, `:18-22` `WireFileCitation`, `:24-30` `WireContainerFileCitation`, `:32-36` `WireFilePath`, `:38-43` `WireAnnotation` union, `:45-49` `WireOutputTextContent.annotations`.
- `:242` decode site (copies wire `annotations` onto domain `output_text` block). The one place provider citations flow into `Items.Annotation`.

Plan references: `plans/deep-research.md:145-149`, `:349`, `:361-363`; `plans/search.md:388-393`, `:418`, `:431`, `:489`.

Unrelated: `packages/providers/browser/src/internal/injected.ts:29` "annotations" = DOM element refs, not citations.

## Bottom line

- `SearchResult`/`SearchResponse` are flat, provider-agnostic, `raw`-preserving; `WebSearchTool` flattens to a numbered text string, no citation objects.
- Citations are modeled once as `Items.Annotation` (`OutputText.annotations`), populated only by provider codecs (Responses `codec.ts:242`), i.e. by native/provider-hosted grounding, not by WebSearch.
- Design decision (`deep-research.md:145-149`): reuse `Items.Annotation`, do not add a new citation type. No streaming-citation mechanism exists or is planned.
