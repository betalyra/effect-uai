import { Effect, Option, Result, Schema } from "effect"
import * as Tool from "@effect-uai/core/Tool"
import { descriptorsOf, providerToolsOf } from "@effect-uai/core/Tool"
import * as Turn from "@effect-uai/core/Turn"
import { describe, expect, it } from "vitest"
import { WireChunk, accumulatorToTurn, buildRequestBody, emptyAccumulator, ingestChunk } from "./codec.js"
import { codeExecutionTool, googleSearchTool, renderProviderTools } from "./GeminiTools.js"

const localTool = Tool.make({
  name: "get_weather",
  description: "Look up the weather.",
  inputSchema: Tool.fromEffectSchema(Schema.Struct({ city: Schema.String })),
  run: ({ city }) => Effect.succeed(`sunny in ${city}`),
})

const build = (toolkit: Record<string, Tool.AnyTool>) => {
  const entries = Result.getOrThrow(renderProviderTools(providerToolsOf(toolkit)))
  return buildRequestBody([], Option.none(), descriptorsOf(toolkit), entries)
}

describe("Gemini provider tools", () => {
  it("renders google_search to the native googleSearch entry", () => {
    const body = build({ google_search: googleSearchTool })
    expect(body.tools).toEqual([{ googleSearch: {} }])
  })

  it("renders a mixed toolkit to both a functionDeclarations entry and the native entry", () => {
    const body = build({ get_weather: localTool, code_execution: codeExecutionTool })
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          expect.objectContaining({ name: "get_weather", description: "Look up the weather." }),
        ],
      },
      { codeExecution: {} },
    ])
  })

  it("omits toolConfig for a grounding-only request (no forced function-calling mode)", () => {
    const body = build({ google_search: googleSearchTool })
    expect(body.toolConfig).toBeUndefined()
  })

  it("sets toolConfig when a function declaration is present", () => {
    const body = build({ get_weather: localTool, google_search: googleSearchTool })
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } })
  })

  it("fails on a foreign provider tool", () => {
    const foreign = Tool.provider({
      name: "web_search",
      description: "Anthropic web search.",
      inputSchema: Tool.noInput,
      provider: "anthropic",
      config: { type: "web_search_20250305" },
    })
    const result = renderProviderTools(providerToolsOf({ web_search: foreign }))
    expect(Result.isFailure(result)).toBe(true)
  })

  it("fails on an unrecognized config kind", () => {
    const bogus = Tool.provider({
      name: "mystery",
      description: "Unknown Gemini tool.",
      inputSchema: Tool.noInput,
      provider: "gemini",
      config: { kind: "telepathy" },
    })
    const result = renderProviderTools(providerToolsOf({ mystery: bogus }))
    expect(Result.isFailure(result)).toBe(true)
  })

  it("maps groundingMetadata chunks to url_citation annotations on the turn", () => {
    const grounded = {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Grounded answer." }] },
          groundingMetadata: {
            webSearchQueries: ["effect ts"],
            groundingChunks: [
              { web: { uri: "https://example.com", title: "Example" } },
              // Duplicate uri (de-duped) and a bare-domain title fallback.
              { web: { uri: "https://example.com", title: "Example" } },
              { web: { uri: "https://effect.website" } },
            ],
          },
          finishReason: "STOP",
        },
      ],
    }
    const chunk = Schema.decodeUnknownSync(WireChunk)(grounded)
    expect(chunk.candidates?.[0]?.content?.parts?.[0]).toEqual({ text: "Grounded answer." })

    const turn = accumulatorToTurn(ingestChunk(emptyAccumulator, chunk).accumulator)
    expect(Turn.citations(turn)).toEqual([
      { type: "url_citation", url: "https://example.com", title: "Example" },
      { type: "url_citation", url: "https://effect.website", title: "https://effect.website" },
    ])
  })

  it("leaves an ungrounded chunk's turn without annotations", () => {
    const chunk = Schema.decodeUnknownSync(WireChunk)({
      candidates: [
        { content: { role: "model", parts: [{ text: "Plain answer." }] }, finishReason: "STOP" },
      ],
    })
    const turn = accumulatorToTurn(ingestChunk(emptyAccumulator, chunk).accumulator)
    expect(Turn.citations(turn)).toEqual([])
  })
})
