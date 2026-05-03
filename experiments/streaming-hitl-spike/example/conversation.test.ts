/**
 * End-to-end test of the recipe. Drives the loop with `MockProvider` and
 * a verdict queue. Verifies:
 *   - `ApprovalRequested` events flow to the consumer for gated calls.
 *   - Streaming tools' intermediates flow through.
 *   - Approved tools execute and produce structured outputs.
 *   - Denied tools produce a `denied` Output without running.
 *   - The loop reaches the final assistant turn.
 */
import { Effect, Queue, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"
import {
  type ToolEvent,
  type Verdict,
  isApprovalRequested,
  isIntermediate,
  isOutput,
} from "../lib/index.js"
import { type State, buildConversation } from "./conversation.js"

const fc = (call_id: string, name: string, args: unknown): Items.FunctionCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: JSON.stringify(args),
})

const turnWithToolCalls: Turn.Turn = {
  stop_reason: "tool_calls",
  usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  items: [
    fc("c1", "web_search", { query: "effect" }),
    fc("c2", "bulk_email", { recipients: ["a@x", "b@x"], subject: "Hi" }),
    fc("c3", "delete_database", { name: "prod" }),
  ],
}

const finalTurn: Turn.Turn = {
  stop_reason: "stop",
  usage: { input_tokens: 25, output_tokens: 15, total_tokens: 40 },
  items: [
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Done." }],
    },
  ],
}

// `loop` unwraps Loop.Events, so the conversation stream emits raw
// `TurnEvent | ToolEvent` values. Discriminate by which shape the value
// has: ToolEvents have `_tag`, TurnEvents have `type`.
const isToolEvent = (e: Turn.TurnEvent | ToolEvent): e is ToolEvent => "_tag" in e
const isTurnEvent = (e: Turn.TurnEvent | ToolEvent): e is Turn.TurnEvent => "type" in e

describe("buildConversation", () => {
  it("end-to-end: streaming + HITL + state threading", async () => {
    const initial: State = { history: [Items.userText("Do the thing")] }

    const program = Effect.gen(function* () {
      const verdicts = yield* Queue.unbounded<Verdict>()
      yield* Queue.offer(verdicts, { call_id: "c2", decision: "approve" })
      yield* Queue.offer(verdicts, {
        call_id: "c3",
        decision: "deny",
        reason: "too risky",
      })
      const conversation = buildConversation(verdicts, initial)
      return yield* Stream.runCollect(conversation)
    })

    const collected = await Effect.runPromise(
      program.pipe(
        Effect.provide(MockProvider.layer([turnWithToolCalls, finalTurn])),
      ),
    )

    const toolEvents = collected.filter(isToolEvent)
    const turnEvents = collected.filter(isTurnEvent)

    // Two ApprovalRequested events for c2 and c3.
    expect(toolEvents.filter(isApprovalRequested)).toHaveLength(2)

    // Six tool intermediates: 3 web_search hits, 3 bulk_email events.
    expect(toolEvents.filter(isIntermediate)).toHaveLength(6)

    // Three tool Outputs (web_search ok, bulk_email ok, delete_database denied).
    const outputs = toolEvents.filter(isOutput).map((e) => e.output)
    expect(outputs).toHaveLength(3)
    const byId = new Map(outputs.map((o) => [o.call_id, o]))
    expect(JSON.parse(byId.get("c1")!.output)).toMatchObject({ count: 3 })
    expect(JSON.parse(byId.get("c2")!.output)).toMatchObject({
      status: "sent",
      delivered: 2,
    })
    expect(JSON.parse(byId.get("c3")!.output)).toMatchObject({
      kind: "denied",
      reason: "too risky",
    })

    // The loop reached the final assistant turn.
    const stops = turnEvents.filter(
      (t) => t.type === "turn_complete" && t.turn.stop_reason === "stop",
    )
    expect(stops).toHaveLength(1)
  })
})
