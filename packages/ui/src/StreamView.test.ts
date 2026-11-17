import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import { type Envelope, RunId, type RunEvent, StreamId } from "./RunEvent.js"
import * as RunView from "./RunView.js"
import * as StreamView from "./StreamView.js"

const station = StreamId.make("station")
const planner = RunId.make("planner")
const program = RunId.make("program")

const frames = (
  stream: StreamId,
  events: ReadonlyArray<readonly [RunId | undefined, RunEvent]>,
): ReadonlyArray<Envelope> =>
  events.map(([runId, event], i) =>
    runId === undefined
      ? { streamId: stream, seq: i + 1, event }
      : { streamId: stream, seq: i + 1, runId, event },
  )

const started = (runId: RunId, name: string): RunEvent => ({
  type: "run-started",
  runId,
  name,
  inputs: [],
  protocol: 3,
})
const clip = (id: string, status: string): RunEvent => ({
  type: "data",
  name: "clip",
  id,
  value: { status },
})

describe("StreamView.step", () => {
  const view = frames(station, [
    [planner, started(planner, "planner")],
    [undefined, clip("1", "planned")],
    [program, started(program, "program")],
    [planner, { type: "text-delta", text: "Segment two: " }],
    [undefined, clip("1", "on-air")],
    [program, { type: "text-delta", text: "Now playing." }],
    [planner, { type: "text-delta", text: "the harbour." }],
    [undefined, { type: "live", name: "clock", value: 12 }],
  ]).reduce(StreamView.step, StreamView.initial)

  it("keeps concurrent runs apart and in start order", () => {
    expect(StreamView.runsOf(view).map((r) => r.name)).toEqual(["planner", "program"])
    expect(StreamView.runsOf(view, "planner").map(RunView.text)).toEqual([
      "Segment two: the harbour.",
    ])
  })

  it("updates a stream-scoped entry in place by id", () => {
    expect(view.data["clip"]).toEqual({ "1": { status: "on-air" } })
    expect(view.live).toEqual({ clock: 12 })
  })

  it("ignores a replayed envelope, and starts over on another stream", () => {
    const replayed = StreamView.step(view, {
      streamId: station,
      seq: 2,
      event: clip("1", "planned"),
    })
    expect(replayed).toBe(view)

    const other = StreamView.step(view, {
      streamId: StreamId.make("radio"),
      seq: 1,
      event: clip("9", "planned"),
    })
    expect(other.order).toEqual([])
    expect(other.data["clip"]).toEqual({ "9": { status: "planned" } })
  })
})

describe("StreamView channels", () => {
  const reply = RunId.make("reply")
  const opened = (channel: number, direction: "up" | "down"): RunEvent => ({
    type: "channel-opened",
    channel,
    direction,
    mimeType: "audio/pcm",
    sampleRate: 16000,
  })
  const at = (n: number) =>
    frames(station, [
      [undefined, opened(0, "up")],
      [reply, started(reply, "reply")],
      [reply, opened(1, "down")],
      [reply, { type: "run-stopped", reason: "barge-in" }],
      [undefined, { type: "channel-closed", channel: 0 }],
    ])
      .slice(0, n)
      .reduce(StreamView.step, StreamView.initial)

  it("lands channels from either scope, noting the run that opened one", () => {
    const view = at(3)
    expect(StreamView.channelsOf(view, "up").map((c) => c.channel)).toEqual([0])
    expect(view.channels["1"]?.runId).toBe(reply)
  })

  it("closes a run's channels when the run ends, and others on channel-closed", () => {
    expect(Object.keys(at(4).channels)).toEqual(["0"])
    expect(at(5).channels).toEqual({})
  })
})
