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
      partial: { title: "Nata", items: ["eggs", "sugar"] },
    })
    const done = RunView.step(view, {
      streamId: s,
      seq: 100,
      runId: r1,
      event: {
        type: "object-done",
        id: "o1",
        name: "recipe",
        value: { title: "Pastéis de nata", items: ["eggs"] },
      },
    })
    expect(done.blocks).toContainEqual({
      type: "object",
      id: "o1",
      name: "recipe",
      status: "done",
      partial: { title: "Nata", items: ["eggs", "sugar"] },
      value: { title: "Pastéis de nata", items: ["eggs"] },
    })
  })

  it("attaches citations to the text they cite, as core output_text annotations", () => {
    const source = { type: "url_citation", url: "https://ipma.pt", title: "IPMA" } as const
    const view = fold([
      started,
      { type: "step-started" },
      { type: "text-delta", text: "Lisbon is " },
      { type: "text-delta", text: "sunny." },
      { type: "citation", annotation: source },
    ])
    expect(view.blocks).toEqual([
      { type: "output_text", id: "b0", text: "Lisbon is sunny.", annotations: [source] },
    ])
  })

  it("keeps a refusal apart from the answer text", () => {
    const view = fold([
      started,
      { type: "step-started" },
      { type: "refusal-delta", text: "I can't " },
      { type: "refusal-delta", text: "help with that." },
    ])
    expect(RunView.text(view)).toBe("")
    expect(RunView.refusal(view)).toBe("I can't help with that.")
  })
})
