import { describe, expect, it } from "@effect/vitest"
import type { ToolCall } from "@effect-uai/core/Items"
import * as CoreToolkit from "@effect-uai/core/Toolkit"
import { Effect, Stream } from "effect"
import type { McpClient } from "./Client.js"
import { decodeCallToolResult } from "./internal/schema.js"
import { mcpToolkit } from "./Toolkit.js"

// A client whose `tools/call` results are raw wire JSON, decoded like the real one.
const clientReturning = (raw: unknown): McpClient => ({
  serverInfo: { name: "fake", protocolVersion: "2026-07-28" },
  listTools: Effect.succeed([{ name: "shot", inputSchema: { type: "object" } }]),
  callTool: () => Effect.orDie(decodeCallToolResult(raw)),
})

const call: ToolCall = { type: "function_call", call_id: "c1", name: "shot", arguments: "{}" }

const historyOf = (raw: unknown) =>
  Effect.gen(function* () {
    const kit = yield* mcpToolkit(clientReturning(raw))
    return yield* CoreToolkit.run(kit, [call]).pipe(
      Stream.filter(CoreToolkit.isOutcome),
      Stream.mapEffect(CoreToolkit.output(kit)),
      Stream.runCollect,
    )
  })

describe("mcpToolkit", () => {
  it.effect("keeps images, audio and resources as media parts instead of dropping them", () =>
    Effect.gen(function* () {
      const [item] = yield* historyOf({
        content: [
          { type: "text", text: "Home page" },
          { type: "image", data: "AQID", mimeType: "image/png" },
          { type: "audio", data: "AAAA", mimeType: "audio/wav" },
          { type: "resource_link", uri: "https://x/a.pdf", name: "a.pdf" },
          { type: "resource", resource: { uri: "mem://n", text: "a note" } },
          { type: "hologram" },
        ],
      })
      expect(item?.output).toEqual([
        { type: "input_text", text: "Home page" },
        {
          type: "input_image",
          source: { _tag: "base64", base64: "AQID", mimeType: "image/png" },
        },
        { type: "input_file", source: { _tag: "base64", base64: "AAAA", mimeType: "audio/wav" } },
        { type: "input_file", source: { _tag: "url", url: "https://x/a.pdf" }, filename: "a.pdf" },
        { type: "input_text", text: "a note" },
        { type: "input_text", text: "[hologram content omitted]" },
      ])
    }),
  )

  it.effect("prefers structuredContent over its repeated text, keeping media", () =>
    Effect.gen(function* () {
      const [item] = yield* historyOf({
        content: [
          { type: "text", text: '{"hits":2}' },
          { type: "image", data: "AQID", mimeType: "image/png" },
        ],
        structuredContent: { hits: 2 },
      })
      expect(item?.output.map((p) => (p.type === "input_json" ? p.value : p.type))).toEqual([
        { hits: 2 },
        "input_image",
      ])
    }),
  )

  it.effect("turns isError into the declared McpToolFailed the model reads", () =>
    Effect.gen(function* () {
      const [item] = yield* historyOf({
        content: [{ type: "text", text: "rate limited" }],
        isError: true,
      })
      expect(item).toMatchObject({
        isError: true,
        output: [{ type: "input_json", value: { _tag: "McpToolFailed", message: "rate limited" } }],
      })
    }),
  )
})
