/**
 * Turn a connected MCP server into a core `Toolkit`, one `LocalTool` per MCP
 * tool. Effectful because the tool list is fetched; composes with
 * `Toolkit.compose` like any other kit.
 */
import { Effect, Option } from "effect"
import * as Tool from "@effect-uai/core/Tool"
import * as CoreToolkit from "@effect-uai/core/Toolkit"
import type { McpClient } from "./Client.js"
import { type McpError, McpProtocolError } from "./McpError.js"
import {
  type CallToolResult,
  type ContentBlock,
  isTextContent,
  type ToolInfo,
} from "./internal/schema.js"

export type McpToolkitOptions = {
  /** Namespace every tool as `<prefix>__<name>`; recommended when composing servers. */
  readonly prefix?: string
}

/**
 * The server owns validation, so the input schema is a passthrough: it carries
 * the server's JSON Schema verbatim (the model sees the real thing) and
 * accepts whatever the model produced. `strict: false` because server schemas
 * are not written to OpenAI strict rules.
 */
const passthroughSchema = (tool: ToolInfo): Tool.ToolInputSchema<unknown> => ({
  "~standard": {
    version: 1,
    vendor: "effect-uai-mcp",
    validate: (value: unknown) => ({ value }),
    jsonSchema: {
      input: () => tool.inputSchema,
      output: () => ({ type: "object" }),
    },
  },
})

const textOf = (block: ContentBlock): string =>
  isTextContent(block) ? block.text : `[${block.type} content omitted]`

/**
 * Serialize a successful result for the model: `structuredContent` when the
 * server provides it, otherwise the joined text blocks. Non-text blocks become
 * a short placeholder until the loop grows a multimodal tool-output path.
 */
const outputOf = (result: CallToolResult): unknown =>
  result.structuredContent ?? (result.content ?? []).map(textOf).join("\n")

/**
 * Two failure channels, deliberately: `isError` is the server telling the
 * model it went wrong, so it becomes a model-visible `ToolFailed`; an
 * `input_required` result is a protocol capability gap the model cannot fix,
 * so it stays a typed `McpError`.
 */
const interpret = (
  name: string,
  result: CallToolResult,
): Effect.Effect<unknown, McpError | Tool.ToolFailed> => {
  if (result.isError === true) {
    return Tool.fail(String(outputOf(result)), { kind: "tool_failed" })
  }
  if (result.resultType === "input_required") {
    return Effect.fail(
      new McpProtocolError({
        method: "tools/call",
        reason: `${name} requires interactive input (MRTR), unsupported by this client`,
      }),
    )
  }
  return Effect.succeed(outputOf(result))
}

const runTool =
  (client: McpClient, name: string) =>
  (input: unknown): Effect.Effect<unknown, McpError | Tool.ToolFailed> =>
    client.callTool(name, input).pipe(Effect.flatMap((result) => interpret(name, result)))

const toLocalTool = (client: McpClient, info: ToolInfo) =>
  Tool.make({
    name: info.name,
    description: info.description ?? info.name,
    inputSchema: passthroughSchema(info),
    run: runTool(client, info.name),
    strict: false,
  })

/**
 * Build a `Toolkit` from the server's advertised tools. The list is snapshotted
 * here; a tool that later vanishes surfaces through `Toolkit.run`'s graceful
 * `unknown_tool` path.
 */
export const mcpToolkit = (
  client: McpClient,
  options?: McpToolkitOptions,
): Effect.Effect<CoreToolkit.Toolkit, McpError> =>
  client.listTools.pipe(
    Effect.map((tools) => CoreToolkit.fromArray(tools.map((info) => toLocalTool(client, info)))),
    Effect.map((kit) =>
      Option.fromNullishOr(options?.prefix).pipe(
        Option.match({
          onNone: () => kit,
          onSome: (prefix) => CoreToolkit.namespace(prefix, kit),
        }),
      ),
    ),
  )
