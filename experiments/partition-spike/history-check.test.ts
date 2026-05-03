import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import { cancelAllPending, findUnansweredCalls, isReconciled } from "./history-check.js"

const fc = (call_id: string, name: string): Items.FunctionCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: "{}",
})

const out = (call_id: string): Items.FunctionCallOutput => ({
  type: "function_call_output",
  call_id,
  output: "ok",
})

describe("findUnansweredCalls", () => {
  it("returns [] for fully reconciled history", () => {
    const history: ReadonlyArray<Items.Item> = [
      Items.userText("hi"),
      fc("a", "x"),
      out("a"),
    ]
    expect(findUnansweredCalls(history)).toEqual([])
    expect(isReconciled(history)).toBe(true)
  })

  it("returns the orphan when an output is missing", () => {
    const history: ReadonlyArray<Items.Item> = [
      Items.userText("hi"),
      fc("a", "x"),
      fc("b", "y"),
      out("a"),
    ]
    const unanswered = findUnansweredCalls(history)
    expect(unanswered.map((c) => c.call_id)).toEqual(["b"])
    expect(isReconciled(history)).toBe(false)
  })

  it("preserves source order across multiple orphans", () => {
    const history: ReadonlyArray<Items.Item> = [
      fc("c", "z"),
      fc("a", "x"),
      fc("b", "y"),
      out("a"),
    ]
    const unanswered = findUnansweredCalls(history)
    expect(unanswered.map((c) => c.call_id)).toEqual(["c", "b"])
  })

  it("treats outputs anywhere in history as resolving (not just immediately after)", () => {
    const history: ReadonlyArray<Items.Item> = [
      fc("a", "x"),
      Items.userText("..."),
      fc("b", "y"),
      out("b"),
      out("a"),
    ]
    expect(findUnansweredCalls(history)).toEqual([])
  })

  it("ignores outputs whose call_id has no matching call (defensive)", () => {
    const history: ReadonlyArray<Items.Item> = [out("ghost"), fc("a", "x")]
    expect(findUnansweredCalls(history).map((c) => c.call_id)).toEqual(["a"])
  })
})

describe("cancelAllPending", () => {
  it("emits cancellation outputs for each orphan, in source order", () => {
    const history: ReadonlyArray<Items.Item> = [
      fc("a", "x"),
      fc("b", "y"),
      out("a"),
    ]
    const cancellations = cancelAllPending(history, "User pivoted.")
    expect(cancellations.map((c) => c.call_id)).toEqual(["b"])
    expect(JSON.parse(cancellations[0]!.output)).toEqual({
      kind: "cancelled",
      reason: "User pivoted.",
    })
  })

  it("returns [] for already-reconciled history", () => {
    const history: ReadonlyArray<Items.Item> = [fc("a", "x"), out("a")]
    expect(cancelAllPending(history)).toEqual([])
  })

  it("makes the history submittable when appended", () => {
    const history: ReadonlyArray<Items.Item> = [fc("a", "x"), fc("b", "y")]
    const reconciled: ReadonlyArray<Items.Item> = [...history, ...cancelAllPending(history)]
    expect(isReconciled(reconciled)).toBe(true)
  })
})
