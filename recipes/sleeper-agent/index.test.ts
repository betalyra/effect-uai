import * as Items from "@effect-uai/core/Items"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Turn from "@effect-uai/core/Turn"
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Ref, Stream } from "effect"
import { NonEmptyArray } from "effect/Array"
import { TestClock } from "effect/testing"
import { conversation, forkPipelinePoller, type PipelineStatus } from "./index.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const assistantText = (text: string): Turn.Turn => ({
  stop_reason: "stop",
  usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
  items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
})

const toolCallTurn = (call_id: string, args: unknown): Turn.Turn => ({
  stop_reason: "tool_calls",
  usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
  items: [
    {
      type: "function_call",
      call_id,
      name: "trigger_deploy",
      arguments: JSON.stringify(args),
    },
  ],
})

const makeCheckStatus = (statuses: NonEmptyArray<PipelineStatus>) => {
  const cursor = Ref.makeUnsafe(0)
  return (_id: string): Effect.Effect<PipelineStatus> =>
    Ref.getAndUpdate(cursor, (n) => Math.min(n + 1, statuses.length - 1)).pipe(
      Effect.map((i) => statuses[i]!),
    )
}

// ---------------------------------------------------------------------------
// forkPipelinePoller
// ---------------------------------------------------------------------------

// Forks the poller into an explicit scope, awaits the signal, then lets the
// scope close (interrupting the now-finished poller).
const runPoller = (pipelineId: string, checkStatus: ReturnType<typeof makeCheckStatus>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const signal = yield* forkPipelinePoller(pipelineId, checkStatus, scope, "10 millis")
      return yield* Deferred.await(signal)
    }),
  )

describe("forkPipelinePoller", () => {
  it.effect("resolves the deferred when pipeline reaches a terminal status", () =>
    Effect.gen(function* () {
      const checkStatus = makeCheckStatus(["pending", "running", "success"])
      const result = yield* runPoller("pipeline-main", checkStatus)
      expect(result).toEqual({ pipelineId: "pipeline-main", status: "success" })
    }).pipe(TestClock.withLive),
  )

  it.effect("resolves with failure when pipeline fails", () =>
    Effect.gen(function* () {
      const checkStatus = makeCheckStatus(["pending", "failure"])
      const result = yield* runPoller("pipeline-feat", checkStatus)
      expect(result).toEqual({ pipelineId: "pipeline-feat", status: "failure" })
    }).pipe(TestClock.withLive),
  )

  it.effect("resolves immediately when first check is already terminal", () =>
    Effect.gen(function* () {
      const checkStatus = makeCheckStatus(["success"])
      const result = yield* runPoller("pipeline-fast", checkStatus)
      expect(result).toEqual({ pipelineId: "pipeline-fast", status: "success" })
    }).pipe(TestClock.withLive),
  )
})

// ---------------------------------------------------------------------------
// conversation
// ---------------------------------------------------------------------------

describe("conversation", () => {
  it.live("waits for the pipeline deferred between turns", () =>
    Effect.gen(function* () {
      // Script:
      //   Turn 1: model calls trigger_deploy
      //   Turn 2: model responds with final text (after pipeline resolves)
      const scriptedTurns = [
        toolCallTurn("c1", { branch: "main" }),
        assistantText("The deployment completed successfully!"),
      ]
      const { layer, recorder } = MockProvider.layerWithRecorder(scriptedTurns)
      const checkStatus = makeCheckStatus(["pending", "running", "success"])

      const { calls } = yield* Effect.gen(function* () {
        yield* Stream.runDrain(conversation(checkStatus, "10 millis"))
        return yield* recorder
      }).pipe(Effect.provide(layer))

      expect(calls).toHaveLength(2)

      // Turn 2's history should contain the pipeline completion message
      const userTexts = calls[1]!.history
        .filter((i): i is Items.Message => i.type === "message" && i.role === "user")
        .flatMap((m) => m.content)
        .filter(Items.isInputText)
        .map((c) => c.text)

      expect(userTexts.some((t) => t.includes("pipeline-main"))).toBe(true)
      expect(userTexts.some((t) => t.includes("success"))).toBe(true)
    }),
  )

  it.effect("proceeds immediately when there is no pending pipeline", () =>
    Effect.gen(function* () {
      // Model never calls a tool — the loop should not block on any Deferred
      const scriptedTurns = [assistantText("Nothing to deploy.")]
      const { layer, recorder } = MockProvider.layerWithRecorder(scriptedTurns)
      const checkStatus = makeCheckStatus(["pending"])

      const { calls } = yield* Effect.gen(function* () {
        yield* Stream.runDrain(conversation(checkStatus, "10 millis"))
        return yield* recorder
      }).pipe(Effect.provide(layer))

      expect(calls).toHaveLength(1)
    }),
  )

  it.effect("includes tool output in the second turn's history", () =>
    Effect.gen(function* () {
      const scriptedTurns = [toolCallTurn("c1", { branch: "staging" }), assistantText("Done.")]
      const { layer, recorder } = MockProvider.layerWithRecorder(scriptedTurns)
      const checkStatus = makeCheckStatus(["success"])

      const { calls } = yield* Effect.gen(function* () {
        yield* Stream.runDrain(conversation(checkStatus, "10 millis"))
        return yield* recorder
      }).pipe(Effect.provide(layer))

      expect(calls).toHaveLength(2)

      // Turn 2 should have the function_call and function_call_output in history
      const secondHistory = calls[1]!.history
      expect(secondHistory.some((i) => i.type === "function_call")).toBe(true)
      expect(secondHistory.some((i) => i.type === "function_call_output")).toBe(true)
    }),
  )
})
