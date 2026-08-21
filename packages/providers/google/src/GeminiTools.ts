import { Match, Result, Schema } from "effect"
import * as Tool from "@effect-uai/core/Tool"
import type { RequestTool } from "./codec.js"

// ---------------------------------------------------------------------------
// Gemini provider-hosted tools. Each is a `Tool.provider` whose `config`
// carries the discriminant the renderer maps to a native `tools[]` entry
// (`googleSearch`, `urlContext`, `codeExecution`). The `inputSchema` is never
// sent — provider tools are partitioned out of the function declarations — so
// `Tool.noInput` suffices.
// Reference: https://ai.google.dev/api/caching#Tool
// ---------------------------------------------------------------------------

/** Discriminated config for a Gemini hosted tool. */
export const GeminiToolConfig = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("google_search") }),
  Schema.Struct({ kind: Schema.Literal("url_context") }),
  Schema.Struct({ kind: Schema.Literal("code_execution") }),
])
export type GeminiToolConfig = typeof GeminiToolConfig.Type

/** Google Search grounding, executed by Gemini. */
export const googleSearchTool = Tool.provider({
  name: "google_search",
  description: "Ground the answer with Google Search, executed by Gemini.",
  inputSchema: Tool.noInput,
  provider: "gemini",
  config: { kind: "google_search" } as const,
})

/** URL context: Gemini fetches and reads URLs referenced in the prompt. */
export const urlContextTool = Tool.provider({
  name: "url_context",
  description: "Let Gemini fetch and read URLs referenced in the prompt.",
  inputSchema: Tool.noInput,
  provider: "gemini",
  config: { kind: "url_context" } as const,
})

/** Code execution: Gemini runs generated Python in a sandbox. */
export const codeExecutionTool = Tool.provider({
  name: "code_execution",
  description: "Let Gemini write and run Python in a sandbox.",
  inputSchema: Tool.noInput,
  provider: "gemini",
  config: { kind: "code_execution" } as const,
})

/**
 * A provider tool this adapter cannot render — a foreign `provider` or an
 * unrecognized `config`. Carried as data so `Gemini.ts` can lift it into a
 * typed `AiError.Unsupported`, mirroring how `hasUrlImageSource` surfaces a
 * request-shaping failure.
 */
export type ToolRenderError = {
  readonly capability: string
  readonly reason: string
}

const decodeConfig = Schema.decodeUnknownResult(GeminiToolConfig)

const configToWire = Match.type<GeminiToolConfig>().pipe(
  Match.discriminatorsExhaustive("kind")({
    google_search: (): RequestTool => ({ googleSearch: {} }),
    url_context: (): RequestTool => ({ urlContext: {} }),
    code_execution: (): RequestTool => ({ codeExecution: {} }),
  }),
)

const renderOne = (
  tool: Tool.ProviderTool<string, any, string, any>,
): Result.Result<RequestTool, ToolRenderError> =>
  tool.provider !== "gemini"
    ? Result.fail({
        capability: `providerTool:${tool.provider}`,
        reason: `tool "${tool.name}" is hosted by "${tool.provider}", not gemini`,
      })
    : decodeConfig(tool.config).pipe(
        Result.map(configToWire),
        Result.mapError((): ToolRenderError => ({
          capability: "providerTool",
          reason: `unrecognized Gemini provider tool config on "${tool.name}"`,
        })),
      )

/**
 * Render a toolkit's Gemini provider tools to native `tools[]` entries. Fails
 * with a `ToolRenderError` on the first foreign or unrecognized tool rather
 * than dropping it.
 */
export const renderProviderTools = (
  tools: ReadonlyArray<Tool.ProviderTool<string, any, string, any>>,
): Result.Result<ReadonlyArray<RequestTool>, ToolRenderError> => Result.all(tools.map(renderOne))
