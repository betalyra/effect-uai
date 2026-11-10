/**
 * Turn a connected MCP server into a core `Toolkit`, one local tool per MCP
 * tool. Effectful because the tool list is fetched; composes with
 * `Toolkit.compose` like any other kit.
 */
import { Effect, Match, Option, Schema } from "effect"
import * as Content from "@effect-uai/core/Content"
import { fileBase64, fileUrl } from "@effect-uai/core/File"
import { imageBase64 } from "@effect-uai/core/Image"
import * as Tool from "@effect-uai/core/Tool"
import * as CoreToolkit from "@effect-uai/core/Toolkit"
import * as ToolOutput from "@effect-uai/core/ToolOutput"
import type { McpClient } from "./Client.js"
import { type McpError, McpProtocolError } from "./McpError.js"
import {
  type CallToolResult,
  type ContentBlock,
  isKnownContent,
  type KnownContent,
  type ToolInfo,
} from "./internal/schema.js"

export type McpToolkitOptions = {
  /** Namespace every tool as `<prefix>__<name>`; recommended when composing servers. */
  readonly prefix?: string
}

/** The server reported an error (`isError`); the model sees its content as `message`. */
export class McpToolFailed extends Schema.TaggedError<McpToolFailed>(
  "@betalyra/effect-uai/mcp/McpToolFailed",
)("McpToolFailed", { message: Schema.String }) {}

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

// A blob without a MIME type is opaque bytes.
const knownValue = Match.type<KnownContent>().pipe(
  Match.discriminatorsExhaustive("type")({
    text: (b): string | Content.Media => b.text,
    image: (b) => Content.image(imageBase64(b.data, b.mimeType)),
    audio: (b) => Content.file(fileBase64(b.data, b.mimeType)),
    resource_link: (b) => Content.file(fileUrl(b.uri, b.mimeType), b.name),
    resource: ({ resource }) =>
      "text" in resource
        ? resource.text
        : Content.file(fileBase64(resource.blob, resource.mimeType ?? "application/octet-stream")),
  }),
)

const valueOf = (block: ContentBlock): string | Content.Media =>
  isKnownContent(block) ? knownValue(block) : `[${block.type} content omitted]`

/**
 * A result as the tool's value: `structuredContent` when the server provides it
 * (its text blocks usually repeat it), plus any media; otherwise every block.
 */
const outputOf = (result: CallToolResult): Content.Value => {
  const values: ReadonlyArray<Schema.Json | Content.Media> = (result.content ?? []).map(valueOf)
  return Option.match(Option.fromNullishOr(result.structuredContent), {
    onNone: () => ToolOutput.single(values),
    onSome: (structured) => ToolOutput.single([structured, ...values.filter(Content.isMedia)]),
  })
}

const messageOf = (result: CallToolResult): string =>
  (result.content ?? [])
    .map(valueOf)
    .filter((v): v is string => typeof v === "string")
    .join("\n")

/**
 * Two failure channels, deliberately: `isError` is the server telling the
 * model it went wrong, so it becomes the declared `McpToolFailed`; an
 * `input_required` result is a protocol capability gap the model cannot fix,
 * so it stays a typed `McpError` and fails the run.
 */
const interpret = (
  name: string,
  result: CallToolResult,
): Effect.Effect<Content.Value, McpError | McpToolFailed> =>
  Match.value(result).pipe(
    Match.when({ isError: true }, (r) => Effect.fail(new McpToolFailed({ message: messageOf(r) }))),
    Match.when({ resultType: "input_required" }, () =>
      Effect.fail(
        new McpProtocolError({
          method: "tools/call",
          reason: `${name} requires interactive input (MRTR), unsupported by this client`,
        }),
      ),
    ),
    Match.orElse((r) => Effect.succeed(outputOf(r))),
  )

const toLocalTool = (client: McpClient, info: ToolInfo) =>
  Tool.make({
    name: info.name,
    description: info.description ?? info.name,
    inputSchema: passthroughSchema(info),
    // Known only at runtime: any mix of text, JSON and media.
    outputSchema: Content.Value,
    failureSchema: McpToolFailed,
    run: (input) =>
      client.callTool(info.name, input).pipe(Effect.flatMap((r) => interpret(info.name, r))),
    strict: false,
  })

/**
 * Build a `Toolkit` from the server's advertised tools. The list is snapshotted
 * here; a tool that later vanishes surfaces as `Toolkit.run`'s `UnknownTool`.
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
