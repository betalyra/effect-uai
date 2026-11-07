import type * as Items from "@effect-uai/core/Items"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { describe, it } from "@effect/vitest"
import { Effect, Option, pipe, Schema, Stream } from "effect"
import { expect } from "vitest"
import * as Input from "./Input.js"
import * as Projection from "./Projection.js"
import * as Run from "./Run.js"
import { type Envelope, InputId, RunId, type RunEvent, StreamId } from "./RunEvent.js"
import * as RunView from "./RunView.js"
import * as SseEncoding from "./SseEncoding.js"
import * as Thread from "./Thread.js"

const getWeather = Tool.make({
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({ city: Schema.String, temperatureC: Schema.Number }),
  run: ({ city }) => Effect.succeed({ city, temperatureC: 19.4 }),
})
const toolkit = Toolkit.make(getWeather)
const usage = { input_tokens: 5, output_tokens: 5 }

type State = { readonly history: ReadonlyArray<Items.HistoryItem> }

// Server side: a real tool loop, projected, bracketed, sequenced, framed as SSE bytes.
const serve = (inputId: InputId) => {
  const { service } = MockProvider.make([
    {
      stop_reason: "tool_calls",
      usage,
      items: [
        {
          type: "function_call",
          call_id: "c1",
          name: "get_weather",
          arguments: `{"city":"Lisbon"}`,
        },
      ],
    },
    {
      stop_reason: "stop",
      usage,
      items: [
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "19°C." }] },
      ],
    },
  ])
  const initialState: State = { history: [] }
  return pipe(
    initialState,
    loop((state: State) =>
      service.streamTurn({ history: state.history, model: "mock", tools: toolkit }).pipe(
        onTurnComplete((turn) =>
          Effect.sync(() => {
            const calls = Turn.getToolCalls(turn)
            return calls.length === 0
              ? stop()
              : Toolkit.run(toolkit, calls).pipe(
                  Toolkit.continueWithResults(Toolkit.appendToolResults(state, turn)),
                )
          }),
        ),
      ),
    ),
    Projection.toRunEvents(),
    Stream.catchCause((cause) => Stream.succeed(Run.failed(cause))),
    Run.start({ runId: RunId.make("r1"), inputs: [inputId] }),
    Run.complete,
    Run.sequence(StreamId.make("st_1")),
    SseEncoding.encode,
  )
}

const receive = (bytes: Stream.Stream<Uint8Array, Schema.SchemaError>) =>
  bytes.pipe(SseEncoding.decode, Stream.runCollect)

describe("Thread over the wire", () => {
  it.effect("folds a served tool run into a settled assistant message", () =>
    Effect.gen(function* () {
      const input = { ...Input.submit("Weather in Lisbon?"), id: InputId.make("in_1") }
      const envelopes = yield* receive(serve(input.id))
      const thread = envelopes.reduce(Thread.step, Thread.submitted(Thread.initial, input))

      expect(thread.active).toBeNull()
      expect(thread.messages.map((m) => m.role)).toEqual(["user", "assistant"])
      const assistant = thread.messages[1]
      expect(assistant?.role === "assistant" && assistant.value.status).toBe("completed")
      expect(assistant?.role === "assistant" && assistant.value.usage).toEqual({
        input_tokens: 10,
        output_tokens: 10,
      })
      expect(assistant?.role === "assistant" && assistant.value.blocks).toMatchObject([
        {
          type: "tool",
          id: "c1",
          name: "get_weather",
          status: "done",
          input: { city: "Lisbon" },
          output: { city: "Lisbon", temperatureC: 19.4 },
        },
        { type: "output_text", text: "19°C." },
      ])
    }),
  )

  it.effect("is unchanged when a reconnect replays frames it already applied", () =>
    Effect.gen(function* () {
      const input = { ...Input.submit("Weather in Lisbon?"), id: InputId.make("in_1") }
      const envelopes = yield* receive(serve(input.id))
      const start = Thread.submitted(Thread.initial, input)
      const once = envelopes.reduce(Thread.step, start)
      // Drop after frame 4, reconnect, receive everything again from the start.
      const replayed = [...envelopes.slice(0, 4), ...envelopes].reduce(Thread.step, start)
      expect(replayed).toEqual(once)
    }),
  )
})

describe("Thread across streams", () => {
  // One stream per run: each run's seq starts at 1 again.
  const run = (stream: string, text: string): ReadonlyArray<Envelope> =>
    (
      [
        {
          type: "run-started",
          runId: RunId.make(stream),
          inputs: [],
          protocol: 1,
        },
        { type: "text-delta", text },
        { type: "run-completed" },
      ] satisfies ReadonlyArray<RunEvent>
    ).map((event, i) => ({
      streamId: StreamId.make(stream),
      seq: i + 1,
      runId: RunId.make(stream),
      event,
    }))

  it("keeps input sent during a run pending until its own run starts", () => {
    const s = StreamId.make("chat")
    const frame = (seq: number, runId: string, event: RunEvent): Envelope => ({
      streamId: s,
      seq,
      runId: RunId.make(runId),
      event,
    })
    const first = { ...Input.submit("first"), id: InputId.make("in_1") }
    const second = { ...Input.submit("second"), id: InputId.make("in_2") }
    const started = (runId: string, input: InputId): RunEvent => ({
      type: "run-started",
      runId: RunId.make(runId),
      inputs: [input],
      protocol: 1,
    })

    const streaming = [
      frame(1, "r1", started("r1", first.id)),
      frame(2, "r1", { type: "text-delta", text: "a" }),
    ].reduce(Thread.step, Thread.submitted(Thread.initial, first))
    const queued = Thread.submitted(streaming, second)
    expect(queued.pending.map((m) => m.id)).toEqual([second.id])

    const done = [
      frame(3, "r1", { type: "run-completed" }),
      frame(4, "r2", started("r2", second.id)),
      frame(5, "r2", { type: "text-delta", text: "b" }),
      frame(6, "r2", { type: "run-completed" }),
    ].reduce(Thread.step, queued)
    expect(done.pending).toEqual([])
    expect(
      done.messages.map((m) => (m.role === "user" ? Input.text(m.value) : RunView.text(m.value))),
    ).toEqual(["first", "a", "second", "b"])
  })

  it("a custom fold rebuilds the conversation from the stream alone (reload): echoes become entries", () => {
    // Entries as plain text instead of the preset's messages / RunView.
    const text = Thread.make({
      toUser: (input: Input.Submit) => Option.some(Input.text(input)),
      settle: RunView.text,
      decodeInput: Schema.decodeUnknownOption(Input.SubmitJson),
    })
    const s = StreamId.make("chat")
    const r = RunId.make("r1")
    const echo = Schema.encodeSync(Input.SubmitJson)({
      ...Input.submit("hi"),
      id: InputId.make("in_1"),
    })
    const frames: ReadonlyArray<Envelope> = [
      { streamId: s, seq: 1, event: { type: "input-accepted", input: echo } },
      {
        streamId: s,
        seq: 2,
        runId: r,
        event: {
          type: "run-started",
          runId: r,
          inputs: [InputId.make("in_1")],
          protocol: 1,
        },
      },
      { streamId: s, seq: 3, runId: r, event: { type: "text-delta", text: "Hello" } },
      { streamId: s, seq: 4, runId: r, event: { type: "run-completed" } },
    ]

    const afterEcho = text.step(text.initial, frames[0]!)
    expect(afterEcho.pending.map((m) => m.value)).toEqual(["hi"])

    const done = frames.reduce(text.step, text.initial)
    expect(done.pending).toEqual([])
    expect(done.messages.map((m) => [m.role, m.value])).toEqual([
      ["user", "hi"],
      ["assistant", "Hello"],
    ])
  })

  it("does not mistake a later run on a new stream for a replay", () => {
    const thread = [...run("a", "first"), ...run("b", "second")].reduce(Thread.step, Thread.initial)
    expect(
      thread.messages.map((m) => (m.role === "assistant" ? RunView.text(m.value) : "")),
    ).toEqual(["first", "second"])
  })
})

describe("Thread approvals", () => {
  const s = StreamId.make("chat")
  const frame = (seq: number, runId: string, event: RunEvent): Envelope => ({
    streamId: s,
    seq,
    runId: RunId.make(runId),
    event,
  })
  const ask = { ...Input.submit("Book a table for 8"), id: InputId.make("in_1") }
  const call = { callId: "call_1", name: "book_table", input: { time: "20:00" } }

  // The first run asks for approval and ends interrupted.
  const interrupted = [
    frame(1, "r1", { type: "run-started", runId: RunId.make("r1"), inputs: [ask.id], protocol: 1 }),
    frame(2, "r1", { type: "tool-call-ready", ...call }),
    frame(3, "r1", { type: "run-interrupted", interrupts: [{ ...call, reason: "approval" }] }),
  ].reduce(Thread.step, Thread.submitted(Thread.initial, ask))

  // The answer runs the call (or not) in the next run.
  const answer = (approved: boolean, result: RunEvent) => {
    const resolve = { ...Input.resolve([{ callId: "call_1", approved }]), id: InputId.make("in_2") }
    return [
      frame(4, "r2", {
        type: "run-started",
        runId: RunId.make("r2"),
        inputs: [resolve.id],
        protocol: 1,
      }),
      frame(5, "r2", result),
      frame(6, "r2", { type: "text-delta", text: approved ? "Booked." : "Not booked." }),
      frame(7, "r2", { type: "run-completed" }),
    ].reduce(Thread.step, Thread.submitted(interrupted, resolve))
  }

  const blocksOf = (thread: Thread.Thread, index: number) => {
    const m = thread.messages[index]
    return m?.role === "assistant" ? m.value.blocks : []
  }

  it("an approved call's result updates the card it was asked from", () => {
    const thread = answer(true, {
      type: "tool-result",
      callId: "call_1",
      name: "book_table",
      output: { booked: true },
      isError: false,
    })
    expect(blocksOf(thread, 1)).toMatchObject([
      { type: "tool", id: "call_1", status: "done", output: { booked: true } },
    ])
    expect(blocksOf(thread, 2)).toEqual([{ type: "output_text", id: "b0", text: "Booked." }])
  })

  it("a denied call fails on the same card, with the server's kind", () => {
    const thread = answer(false, {
      type: "tool-result",
      callId: "call_1",
      name: "book_table",
      output: { kind: "denied" },
      isError: true,
    })
    expect(blocksOf(thread, 1)).toMatchObject([
      { type: "tool", id: "call_1", status: "failed", error: { kind: "denied" } },
    ])
    expect(blocksOf(thread, 2)).toEqual([{ type: "output_text", id: "b0", text: "Not booked." }])
  })
})
