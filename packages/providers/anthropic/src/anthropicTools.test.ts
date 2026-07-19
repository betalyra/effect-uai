import { Effect, Option, Result, Schema } from "effect"
import * as Tool from "@effect-uai/core/Tool"
import { descriptorsOf, providerToolsOf } from "@effect-uai/core/Tool"
import { describe, expect, it } from "vitest"
import { codeExecutionTool, renderProviderTools, webSearchTool } from "./AnthropicTools.js"
import { accumulatorToTurn, buildRequestBody, emptyAccumulator } from "./codec.js"
import { KnownProviderEvent, applyEvent } from "./streamEvents.js"

const localTool = Tool.make({
  name: "get_weather",
  description: "Look up the weather.",
  inputSchema: Tool.fromEffectSchema(Schema.Struct({ city: Schema.String })),
  run: ({ city }) => Effect.succeed(`sunny in ${city}`),
})

const wireFor = (toolkit: Record<string, Tool.AnyTool>) =>
  Result.getOrThrow(renderProviderTools(providerToolsOf(toolkit)))

const functionWire = (toolkit: Record<string, Tool.AnyTool>) =>
  descriptorsOf(toolkit).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))

const buildWith = (
  toolkit: Record<string, Tool.AnyTool>,
  toolChoice: Option.Option<Record<string, unknown>> = Option.none(),
) => {
  const tools = [...functionWire(toolkit), ...wireFor(toolkit)]
  return Result.getOrThrow(
    buildRequestBody({
      model: "claude-sonnet-4-5",
      history: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      maxTokens: 1024,
      temperature: Option.none(),
      topP: Option.none(),
      topK: Option.none(),
      stopSequences: Option.none(),
      thinking: Option.none(),
      tools: tools.length > 0 ? Option.some(tools) : Option.none(),
      toolChoice,
      userId: Option.none(),
      outputConfig: Option.none(),
      cacheControl: Option.none(),
    }),
  )
}

describe("Anthropic provider tools", () => {
  it("renders web_search to the native wire entry with options", () => {
    const wire = wireFor({
      web_search: webSearchTool({ maxUses: 3, allowedDomains: ["example.com"] }),
    })
    expect(wire).toEqual([
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
        allowed_domains: ["example.com"],
      },
    ])
  })

  it("renders code_execution to its native wire entry", () => {
    expect(wireFor({ code_execution: codeExecutionTool })).toEqual([
      { type: "code_execution_20250522", name: "code_execution" },
    ])
  })

  it("emits both a custom tool and the native entry in the same tools array", () => {
    const body = buildWith({ get_weather: localTool, web_search: webSearchTool() })
    expect(body.tools).toEqual([
      expect.objectContaining({ name: "get_weather" }),
      { type: "web_search_20250305", name: "web_search" },
    ])
  })

  it("omits tool_choice for a native-only request", () => {
    const body = buildWith({ web_search: webSearchTool() })
    expect(body.tools).toHaveLength(1)
    expect(body.tool_choice).toBeUndefined()
  })

  it("fails on a foreign provider tool", () => {
    const foreign = Tool.provider({
      name: "google_search",
      description: "Gemini grounding.",
      inputSchema: Tool.noInput,
      provider: "gemini",
      config: { kind: "google_search" },
    })
    expect(Result.isFailure(renderProviderTools(providerToolsOf({ google_search: foreign })))).toBe(
      true,
    )
  })

  it("fails on an unrecognized config", () => {
    const bogus = Tool.provider({
      name: "mystery",
      description: "Unknown Anthropic tool.",
      inputSchema: Tool.noInput,
      provider: "anthropic",
      config: { kind: "telepathy" },
    })
    expect(Result.isFailure(renderProviderTools(providerToolsOf({ mystery: bogus })))).toBe(true)
  })
})

describe("Anthropic hosted-tool response tolerance", () => {
  it("does not decode a server_tool_use content block as a known event", () => {
    const serverToolUse = {
      type: "content_block_start",
      index: 0,
      content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} },
    }
    const decoded = Schema.decodeUnknownResult(KnownProviderEvent)(serverToolUse)
    // Fails to decode → the SSE layer synthesizes `_unknown`, which is ignored.
    expect(Result.isFailure(decoded)).toBe(true)
  })

  it("builds the text turn when hosted-tool blocks arrive as _unknown", () => {
    // Sequence: server_tool_use + web_search_tool_result blocks flow through as
    // `_unknown` (no accumulator change); the assistant's text answer is a
    // normal text block and survives into the turn.
    const events = [
      { type: "_unknown", raw: { type: "content_block_start", content_block: "server_tool_use" } },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Grounded answer." },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_stop" },
    ] as const
    const acc = events.reduce(applyEvent, emptyAccumulator)
    const turn = accumulatorToTurn(acc)
    expect(turn.items).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Grounded answer." }],
      },
    ])
  })
})
