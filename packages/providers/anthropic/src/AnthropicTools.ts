import { Match, Result, Schema } from "effect"
import * as Tool from "@effect-uai/core/Tool"

// ---------------------------------------------------------------------------
// Anthropic provider-hosted tools. Each is a `Tool.provider` whose `config`
// carries the version-dated wire `type` string plus its options; the renderer
// maps it to a native entry appended to the `tools` array alongside custom
// tools. The `inputSchema` is never sent (provider tools are partitioned out
// of the custom-tool declarations), so `Tool.noInput` suffices.
// Reference: https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/web-search-tool
// ---------------------------------------------------------------------------

const WEB_SEARCH_TYPE = "web_search_20250305"
const CODE_EXECUTION_TYPE = "code_execution_20250522"

const UserLocation = Schema.Struct({
  city: Schema.optional(Schema.String),
  region: Schema.optional(Schema.String),
  country: Schema.optional(Schema.String),
  timezone: Schema.optional(Schema.String),
})
export type UserLocation = typeof UserLocation.Type

const WebSearchConfig = Schema.Struct({
  kind: Schema.Literal("web_search"),
  type: Schema.String,
  maxUses: Schema.optional(Schema.Number),
  allowedDomains: Schema.optional(Schema.Array(Schema.String)),
  blockedDomains: Schema.optional(Schema.Array(Schema.String)),
  userLocation: Schema.optional(UserLocation),
})

const CodeExecutionConfig = Schema.Struct({
  kind: Schema.Literal("code_execution"),
  type: Schema.String,
})

/** Discriminated config for an Anthropic hosted tool. */
export const AnthropicToolConfig = Schema.Union([WebSearchConfig, CodeExecutionConfig])
export type AnthropicToolConfig = typeof AnthropicToolConfig.Type

export type WebSearchOptions = {
  readonly maxUses?: number
  readonly allowedDomains?: ReadonlyArray<string>
  readonly blockedDomains?: ReadonlyArray<string>
  readonly userLocation?: UserLocation
}

/** Anthropic-hosted web search. */
export const webSearchTool = (opts: WebSearchOptions = {}) =>
  Tool.provider({
    name: "web_search",
    description: "Search the web, executed by Anthropic.",
    inputSchema: Tool.noInput,
    provider: "anthropic",
    config: { kind: "web_search", type: WEB_SEARCH_TYPE, ...opts } as const,
  })

/** Anthropic-hosted code execution (Python sandbox). */
export const codeExecutionTool = Tool.provider({
  name: "code_execution",
  description: "Run Python in a sandbox, executed by Anthropic.",
  inputSchema: Tool.noInput,
  provider: "anthropic",
  config: { kind: "code_execution", type: CODE_EXECUTION_TYPE } as const,
})

/**
 * A provider tool this adapter cannot render — a foreign `provider` or an
 * unrecognized `config`. Carried as data so `Anthropic.ts` can lift it into a
 * typed `AiError.Unsupported`.
 */
export type ToolRenderError = {
  readonly capability: string
  readonly reason: string
}

const userLocationWire = (loc: UserLocation): Record<string, unknown> => ({
  type: "approximate",
  ...(loc.city !== undefined && { city: loc.city }),
  ...(loc.region !== undefined && { region: loc.region }),
  ...(loc.country !== undefined && { country: loc.country }),
  ...(loc.timezone !== undefined && { timezone: loc.timezone }),
})

const configToWire = Match.type<AnthropicToolConfig>().pipe(
  Match.discriminatorsExhaustive("kind")({
    web_search: (c): Record<string, unknown> => ({
      type: c.type,
      name: "web_search",
      ...(c.maxUses !== undefined && { max_uses: c.maxUses }),
      ...(c.allowedDomains !== undefined && { allowed_domains: c.allowedDomains }),
      ...(c.blockedDomains !== undefined && { blocked_domains: c.blockedDomains }),
      ...(c.userLocation !== undefined && { user_location: userLocationWire(c.userLocation) }),
    }),
    code_execution: (c): Record<string, unknown> => ({ type: c.type, name: "code_execution" }),
  }),
)

const decodeConfig = Schema.decodeUnknownResult(AnthropicToolConfig)

const renderOne = (
  tool: Tool.ProviderTool<string, any, string, any>,
): Result.Result<Record<string, unknown>, ToolRenderError> =>
  tool.provider !== "anthropic"
    ? Result.fail({
        capability: `providerTool:${tool.provider}`,
        reason: `tool "${tool.name}" is hosted by "${tool.provider}", not anthropic`,
      })
    : decodeConfig(tool.config).pipe(
        Result.map(configToWire),
        Result.mapError((): ToolRenderError => ({
          capability: "providerTool",
          reason: `unrecognized Anthropic provider tool config on "${tool.name}"`,
        })),
      )

/**
 * Render a toolkit's Anthropic provider tools to native `tools` entries. Fails
 * with a `ToolRenderError` on the first foreign or unrecognized tool rather
 * than dropping it.
 */
export const renderProviderTools = (
  tools: ReadonlyArray<Tool.ProviderTool<string, any, string, any>>,
): Result.Result<ReadonlyArray<Record<string, unknown>>, ToolRenderError> =>
  Result.all(tools.map(renderOne))
