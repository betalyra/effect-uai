import { Result, Schema } from "effect"
import * as Tool from "@effect-uai/core/Tool"
import { providerToolsOf } from "@effect-uai/core/Tool"
import { describe, expect, it } from "vitest"
import { KnownProviderEvent, eventToDeltas, makeCallIdLookup } from "./streamEvents.js"
import {
  codeInterpreterTool,
  fileSearchTool,
  renderProviderTools,
  webSearchTool,
} from "./ResponsesTools.js"

const wireFor = (toolkit: Record<string, Tool.AnyTool>) =>
  Result.getOrThrow(renderProviderTools(providerToolsOf(toolkit)))

describe("Responses provider tool rendering", () => {
  it("maps web_search options onto the native wire fields", () => {
    expect(
      wireFor({
        web_search: webSearchTool({
          searchContextSize: "high",
          filters: { allowedDomains: ["example.com"], blockedDomains: ["spam.com"] },
          userLocation: { city: "Berlin", country: "DE" },
        }),
      }),
    ).toEqual([
      {
        type: "web_search",
        filters: { allowed_domains: ["example.com"], blocked_domains: ["spam.com"] },
        user_location: { type: "approximate", city: "Berlin", country: "DE" },
        search_context_size: "high",
      },
    ])
  })

  it("maps code_interpreter to an auto container (with file ids when given)", () => {
    expect(wireFor({ ci: codeInterpreterTool() })).toEqual([
      { type: "code_interpreter", container: { type: "auto" } },
    ])
    expect(wireFor({ ci: codeInterpreterTool({ fileIds: ["file_1"] }) })).toEqual([
      { type: "code_interpreter", container: { type: "auto", file_ids: ["file_1"] } },
    ])
  })

  it("maps file_search to its vector store ids", () => {
    expect(wireFor({ fs: fileSearchTool({ vectorStoreIds: ["vs_1", "vs_2"] }) })).toEqual([
      { type: "file_search", vector_store_ids: ["vs_1", "vs_2"] },
    ])
  })

  it("fails on a tool hosted by a different provider", () => {
    const foreign = Tool.provider({
      name: "google_search",
      description: "Gemini grounding.",
      inputSchema: Tool.noInput,
      provider: "gemini",
      config: { kind: "google_search" },
    })
    expect(Result.isFailure(renderProviderTools(providerToolsOf({ foreign })))).toBe(true)
  })

  it("fails on an unrecognized config", () => {
    const bogus = Tool.provider({
      name: "mystery",
      description: "Unknown Responses tool.",
      inputSchema: Tool.noInput,
      provider: "openai",
      config: { kind: "telepathy" },
    })
    expect(Result.isFailure(renderProviderTools(providerToolsOf({ bogus })))).toBe(true)
  })
})

describe("Responses hosted-tool response tolerance", () => {
  // The real regression: a hosted-tool output item in `response.completed` must
  // not break the event decode, or `TurnComplete` would never fire. Decoding
  // through the actual event schema (throws on failure) and projecting to
  // TurnEvents proves the grounded text still assembles into a turn.
  const decodeEvent = Schema.decodeUnknownSync(KnownProviderEvent)

  it("emits TurnComplete with just the text answer for a grounded completion", () => {
    const event = decodeEvent({
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          { type: "web_search_call", id: "ws_1", status: "completed" },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Grounded answer." }],
          },
        ],
      },
    })
    const deltas = eventToDeltas(event, makeCallIdLookup())
    const complete = deltas.find((d) => d._tag === "TurnComplete")
    expect(complete).toBeDefined()
    const turn = complete?._tag === "TurnComplete" ? complete.turn : undefined
    expect(turn?.stop_reason).toBe("stop")
    expect(turn?.items).toEqual([
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Grounded answer." }],
        providerData: expect.anything(),
      },
    ])
  })

  // The new streamed-citation path: a real `annotation.added` payload (with the
  // wire's positional fields) must decode and project to a `CitationAdded`
  // carrying a domain `Annotation`. This is what makes native-grounding
  // citations stream instead of only landing on the final turn.
  it("projects a streamed url_citation to CitationAdded", () => {
    const deltas = eventToDeltas(
      decodeEvent({
        type: "response.output_text.annotation.added",
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        annotation_index: 0,
        annotation: {
          type: "url_citation",
          url: "https://example.com/a",
          title: "A",
          start_index: 10,
          end_index: 20,
        },
      }),
      makeCallIdLookup(),
    )
    expect(deltas).toEqual([
      {
        _tag: "CitationAdded",
        annotation: {
          type: "url_citation",
          url: "https://example.com/a",
          title: "A",
          start_index: 10,
          end_index: 20,
        },
      },
    ])
  })
})
