/**
 * Tests for both streaming-tool patterns: sub-agent (text concat) and
 * progress + terminal result (download). Both go through the same
 * recipe shape, only the tools differ.
 */
import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import { type ToolResult, toToolCallOutput } from "@effect-uai/core/ToolResult"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Tool from "@effect-uai/core/Tool"
import { isProgress, isOutput } from "@effect-uai/core/ToolEvent"
import * as Turn from "@effect-uai/core/Turn"
import {
  type DownloadEvent,
  type DownloadOutput,
  type State,
  buildConversation,
  makeDownloadTool,
  makeSubAgent,
} from "./index.js"

const fc = (call_id: string, name: string, args: unknown): Items.ToolCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: JSON.stringify(args),
})

const finalTurn: Turn.Turn = {
  stop_reason: "stop",
  usage: { input_tokens: 25, output_tokens: 15, total_tokens: 40 },
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "All done." }],
    },
  ],
}

describe("streaming-tool-output: sub-agent pattern", () => {
  it("inner deltas flow through; outer model sees joined answer", async () => {
    const mockedInner = (question: string): Stream.Stream<Turn.TurnEvent> =>
      Stream.fromIterable<Turn.TurnEvent>([
        Turn.TurnEvent.TextDelta({ text: `Hmm, "${question}"... ` }),
        Turn.TurnEvent.TextDelta({ text: "let me reason... " }),
        Turn.TurnEvent.TextDelta({ text: "the answer is 42." }),
        Turn.TurnEvent.TurnComplete({
          turn: {
            stop_reason: "stop",
            usage: { input_tokens: 5, output_tokens: 8, total_tokens: 13 },
            items: [
              {
                type: "message",
                role: "assistant",
                content: [
                  {
                    type: "output_text",
                    text: `Hmm, "${question}"... let me reason... the answer is 42.`,
                  },
                ],
              },
            ],
          },
        }),
      ])

    const subAgent = makeSubAgent(mockedInner)
    const allTools: ReadonlyArray<Tool.AnyTool> = [subAgent]

    const turn1: Turn.Turn = {
      stop_reason: "tool_calls",
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      items: [fc("c1", "ask_subagent", { question: "What is the meaning of life?" })],
    }

    const initial: State = {
      history: [Items.userText("ask the subagent")],
      index: 0,
    }

    const collected = await Effect.runPromise(
      Stream.runCollect(buildConversation(allTools, initial)).pipe(
        Effect.provide(MockProvider.layer([turn1, finalTurn])),
      ),
    )

    // 4 inner-stream events flow through as Intermediates.
    const intermediates = collected.filter(isProgress)
    expect(intermediates).toHaveLength(4)

    const textDeltas = intermediates.filter((e) => (e.data as Turn.TurnEvent)._tag === "TextDelta")
    expect(textDeltas).toHaveLength(3)

    // One Output carrying the joined SubAgentOutput.
    const outputs: ReadonlyArray<ToolResult> = collected.filter(isOutput).map((e) => e.result)
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({
      _tag: "Ok",
      tool: "ask_subagent",
      value: {
        answer: 'Hmm, "What is the meaning of life?"... let me reason... the answer is 42.',
      },
    })
  })
})

describe("streaming-tool-output: progress + result pattern", () => {
  it("progress events flow through; finalize picks the result", async () => {
    // Zero per-chunk delay for fast test execution.
    const downloadArtifact = makeDownloadTool("0 millis")
    const allTools: ReadonlyArray<Tool.AnyTool> = [downloadArtifact]

    const turn1: Turn.Turn = {
      stop_reason: "tool_calls",
      usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
      items: [fc("c1", "download_artifact", { url: "example.com/file", chunks: 3 })],
    }

    const initial: State = {
      history: [Items.userText("download the artifact")],
      index: 0,
    }

    const collected = await Effect.runPromise(
      Stream.runCollect(buildConversation(allTools, initial)).pipe(
        Effect.provide(MockProvider.layer([turn1, finalTurn])),
      ),
    )

    // Intermediates: 3 progress + 1 result = 4.
    const intermediates = collected.filter(isProgress)
    expect(intermediates).toHaveLength(4)

    const progressEvents = intermediates.filter(
      (e) => (e.data as DownloadEvent).type === "progress",
    )
    expect(progressEvents).toHaveLength(3)
    expect(
      progressEvents.map((e) => (e.data as Extract<DownloadEvent, { type: "progress" }>).pct),
    ).toEqual([33, 67, 100])

    // One Output carrying the structured DownloadOutput.
    const outputs: ReadonlyArray<ToolResult> = collected.filter(isOutput).map((e) => e.result)
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({
      _tag: "Ok",
      tool: "download_artifact",
      value: {
        status: "completed",
        bytes: "bytes-of-example.com/file",
        chunks: 3,
      } satisfies DownloadOutput,
    })
  })
})
