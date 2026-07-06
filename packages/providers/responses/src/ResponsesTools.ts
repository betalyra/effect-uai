import { Match, Result, Schema } from "effect"
import * as Tool from "@effect-uai/core/Tool"

// ---------------------------------------------------------------------------
// OpenAI Responses provider-hosted tools. Each is a `Tool.provider` whose
// `config` carries the wire `type` string plus its options; the renderer maps
// it to a native entry appended to the `tools` array alongside function tools.
// The `inputSchema` is never sent (provider tools are partitioned out of the
// function declarations), so `Tool.noInput` suffices.
// Reference: https://developers.openai.com/api/docs/guides/tools
// ---------------------------------------------------------------------------

const UserLocation = Schema.Struct({
  city: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
})
export type UserLocation = typeof UserLocation.Type

const WebSearchFilters = Schema.Struct({
  allowedDomains: Schema.optional(Schema.Array(Schema.String)),
  blockedDomains: Schema.optional(Schema.Array(Schema.String)),
})
export type WebSearchFilters = typeof WebSearchFilters.Type

const WebSearchConfig = Schema.Struct({
  kind: Schema.Literal("web_search"),
  filters: Schema.optional(WebSearchFilters),
  userLocation: Schema.optional(UserLocation),
  searchContextSize: Schema.optional(Schema.Literals(["low", "medium", "high"])),
})

const CodeInterpreterConfig = Schema.Struct({
  kind: Schema.Literal("code_interpreter"),
  fileIds: Schema.optional(Schema.Array(Schema.String)),
})

const FileSearchConfig = Schema.Struct({
  kind: Schema.Literal("file_search"),
  vectorStoreIds: Schema.Array(Schema.String),
})

/** Discriminated config for a Responses hosted tool. */
export const ResponsesToolConfig = Schema.Union([
  WebSearchConfig,
  CodeInterpreterConfig,
  FileSearchConfig,
])
export type ResponsesToolConfig = typeof ResponsesToolConfig.Type

export type WebSearchOptions = {
  readonly filters?: WebSearchFilters
  readonly userLocation?: UserLocation
  readonly searchContextSize?: "low" | "medium" | "high"
}

/** OpenAI-hosted web search. */
export const webSearchTool = (opts: WebSearchOptions = {}) =>
  Tool.provider({
    name: "web_search",
    description: "Search the web, executed by OpenAI.",
    inputSchema: Tool.noInput,
    provider: "openai",
    config: { kind: "web_search", ...opts } as const,
  })

/** OpenAI-hosted code interpreter (Python sandbox). */
export const codeInterpreterTool = (opts: { readonly fileIds?: ReadonlyArray<string> } = {}) =>
  Tool.provider({
    name: "code_interpreter",
    description: "Run Python in a sandbox, executed by OpenAI.",
    inputSchema: Tool.noInput,
    provider: "openai",
    config: { kind: "code_interpreter", ...opts } as const,
  })

/** OpenAI-hosted file search over the given vector stores. */
export const fileSearchTool = (opts: { readonly vectorStoreIds: ReadonlyArray<string> }) =>
  Tool.provider({
    name: "file_search",
    description: "Retrieve from uploaded files, executed by OpenAI.",
    inputSchema: Tool.noInput,
    provider: "openai",
    config: { kind: "file_search", vectorStoreIds: opts.vectorStoreIds } as const,
  })

/**
 * A provider tool this adapter cannot render — a foreign `provider` or an
 * unrecognized `config`. Carried as data so `Responses.ts` can lift it into a
 * typed `AiError.Unsupported`.
 */
export type ToolRenderError = {
  readonly capability: string
  readonly reason: string
}

const filtersWire = (f: WebSearchFilters): Record<string, unknown> => ({
  ...(f.allowedDomains !== undefined && { allowed_domains: f.allowedDomains }),
  ...(f.blockedDomains !== undefined && { blocked_domains: f.blockedDomains }),
})

const userLocationWire = (loc: UserLocation): Record<string, unknown> => ({
  type: "approximate",
  ...(loc.city !== undefined && { city: loc.city }),
  ...(loc.region !== undefined && { region: loc.region }),
  ...(loc.country !== undefined && { country: loc.country }),
  ...(loc.timezone !== undefined && { timezone: loc.timezone }),
})

const configToWire = Match.type<ResponsesToolConfig>().pipe(
  Match.discriminatorsExhaustive("kind")({
    web_search: (c): Record<string, unknown> => ({
      type: "web_search",
      ...(c.filters !== undefined && { filters: filtersWire(c.filters) }),
      ...(c.userLocation !== undefined && { user_location: userLocationWire(c.userLocation) }),
      ...(c.searchContextSize !== undefined && { search_context_size: c.searchContextSize }),
    }),
    code_interpreter: (c): Record<string, unknown> => ({
      type: "code_interpreter",
      container: c.fileIds !== undefined ? { type: "auto", file_ids: c.fileIds } : { type: "auto" },
    }),
    file_search: (c): Record<string, unknown> => ({
      type: "file_search",
      vector_store_ids: c.vectorStoreIds,
    }),
  }),
)

const decodeConfig = Schema.decodeUnknownResult(ResponsesToolConfig)

const renderOne = (
  tool: Tool.ProviderTool<string, any, string, any>,
): Result.Result<Record<string, unknown>, ToolRenderError> =>
  tool.provider !== "openai"
    ? Result.fail({
        capability: `providerTool:${tool.provider}`,
        reason: `tool "${tool.name}" is hosted by "${tool.provider}", not openai`,
      })
    : decodeConfig(tool.config).pipe(
        Result.map(configToWire),
        Result.mapError(
          (): ToolRenderError => ({
            capability: "providerTool",
            reason: `unrecognized Responses provider tool config on "${tool.name}"`,
          }),
        ),
      )

/**
 * Render a toolkit's Responses provider tools to native `tools` entries. Fails
 * with a `ToolRenderError` on the first foreign or unrecognized tool rather
 * than dropping it.
 */
export const renderProviderTools = (
  tools: ReadonlyArray<Tool.ProviderTool<string, any, string, any>>,
): Result.Result<ReadonlyArray<Record<string, unknown>>, ToolRenderError> =>
  Result.all(tools.map(renderOne))
