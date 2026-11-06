import { describe, it } from "@effect/vitest"
import { Schema } from "effect"
import { expect } from "vitest"
import { type Envelope, RunId, type RunEvent, StreamId } from "./RunEvent.js"
import * as RunView from "./RunView.js"

const s = StreamId.make("s")
const r1 = RunId.make("r1")

const fold = (events: ReadonlyArray<RunEvent>): RunView.RunView =>
  events
    .map((event, i): Envelope => ({ streamId: s, seq: i + 1, runId: r1, event }))
    .reduce(RunView.step, RunView.initial)

const started: RunEvent = {
  type: "run-started",
  runId: r1,
  messageId: "m1",
  inputs: [],
  protocol: 1,
}

describe("RunView.step", () => {
  it("step-reset drops the failed attempt's partial output but keeps earlier steps", () => {
    const view = fold([
      started,
      { type: "step-started" },
      { type: "text-delta", text: "First step." },
      { type: "step-finished" },
      { type: "step-started" },
      { type: "text-delta", text: "Partial from the failing mod" },
      { type: "step-reset" },
      { type: "text-delta", text: " Retried." },
    ])
    expect(RunView.text(view)).toBe("First step. Retried.")
  })

  it("builds an object from patches, survives a bad patch, and settles on done", () => {
    const Recipe = Schema.Struct({ title: Schema.String, items: Schema.Array(Schema.String) })
    const view = fold([
      started,
      { type: "object-started", id: "o1", name: "recipe" },
      { type: "object-delta", id: "o1", patch: [{ op: "add", path: "/title", value: "Nata" }] },
      { type: "object-delta", id: "o1", patch: [{ op: "add", path: "/items", value: ["eggs"] }] },
      { type: "object-delta", id: "o1", patch: [{ op: "replace", path: "/missing/x", value: 1 }] },
      { type: "object-delta", id: "o1", patch: [{ op: "add", path: "/items/-", value: "sugar" }] },
    ])
    expect(view.blocks).toContainEqual({
      type: "object",
      id: "o1",
      name: "recipe",
      status: "streaming",
      value: { title: "Nata", items: ["eggs", "sugar"] },
    })
    expect(RunView.objects(view, "recipe", Recipe)).toEqual([
      { id: "o1", status: "streaming", value: undefined },
    ])

    const done = RunView.step(view, {
      streamId: s,
      seq: 100,
      runId: r1,
      event: {
        type: "object-done",
        id: "o1",
        value: { title: "Pastéis de nata", items: ["eggs"] },
      },
    })
    expect(RunView.objects(done, "recipe", Recipe)).toEqual([
      { id: "o1", status: "done", value: { title: "Pastéis de nata", items: ["eggs"] } },
    ])
  })
})
