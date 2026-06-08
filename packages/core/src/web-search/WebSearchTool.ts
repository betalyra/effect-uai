import { Effect, Schema } from "effect"
import * as Tool from "../tool/Tool.js"
import { search, SearchRecency, type SearchResult, WebSearch } from "./WebSearch.js"

/**
 * Model-facing argument schema. Deliberately narrow: `query` plus the one
 * filter that is genuinely the model's call - `recency` (it knows whether a
 * question is about current events or evergreen). App-policy scoping
 * (`includeDomains` / `excludeDomains`) and the `maxResults` cost ceiling
 * are pinned on the constructor instead, so they are guaranteed rather than
 * left to the model to remember each call.
 */
const WebSearchToolArgs = Schema.Struct({
  query: Schema.String,
  recency: Schema.optional(SearchRecency),
})

export type WebSearchToolArgs = typeof WebSearchToolArgs.Type

/** Numbered `title / url / snippet` list - what a model reads best. */
const defaultRender = (results: ReadonlyArray<SearchResult>): string =>
  results.length === 0
    ? "No results found."
    : results
        .map((r, i) => {
          const head = `${i + 1}. ${r.title ?? r.url}\n   ${r.url}`
          return r.snippet === undefined ? head : `${head}\n   ${r.snippet}`
        })
        .join("\n\n")

export type WebSearchToolOptions = {
  /** Tool name the model sees. Default `"web_search"`. */
  readonly name?: string
  /**
   * App-fixed ceiling on results per call - a cost guard, not exposed to
   * the model. Default `5`.
   */
  readonly maxResults?: number
  /**
   * App-fixed allowlist applied to every search. A policy scope ("only
   * search our docs"), not a model knob - so it is enforced, not requested.
   */
  readonly includeDomains?: ReadonlyArray<string>
  /** App-fixed denylist applied to every search ("never return X"). */
  readonly excludeDomains?: ReadonlyArray<string>
  /**
   * Override how results are rendered into the model-facing string.
   * Default: a numbered `title / url / snippet` list.
   */
  readonly render?: (results: ReadonlyArray<SearchResult>) => string
}

/**
 * The canonical web-search tool. Its `R` is just `WebSearch`, so providing
 * any search-provider Layer satisfies it and the model-facing contract
 * (name, description, schema) is identical no matter which backend answers
 * - swap `PerplexitySearch.layer` for `ExaSearch.layer` and the tool the
 * model sees does not change. Drops straight into a `Toolkit` and the
 * `LanguageModel` tool-calling loop.
 *
 * The model controls only `query` and `recency`; domain scoping and the
 * result cap are app policy, fixed here on the constructor. `Output` is
 * rendered text, not raw `SearchResult[]`: the model reads the list, while
 * the app still gets the structured results through the normal tool-result
 * channel. Pass `render` to change the format.
 */
export const webSearchTool = (
  options?: WebSearchToolOptions,
): Tool.Tool<string, WebSearchToolArgs, string, WebSearch> => {
  const render = options?.render ?? defaultRender
  const maxResults = options?.maxResults ?? 5
  const includeDomains = options?.includeDomains
  const excludeDomains = options?.excludeDomains
  return Tool.make({
    name: options?.name ?? "web_search",
    description:
      "Search the web for current information. Returns ranked results with titles, URLs, and snippets.",
    inputSchema: Tool.fromEffectSchema(WebSearchToolArgs),
    run: (args) =>
      search({
        query: args.query,
        maxResults,
        ...(args.recency !== undefined && { recency: args.recency }),
        ...(includeDomains !== undefined && { includeDomains }),
        ...(excludeDomains !== undefined && { excludeDomains }),
      }).pipe(Effect.map((r) => render(r.results))),
  })
}
