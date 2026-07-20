import { describe, it } from "@effect/vitest"
import { Array as Arr, Duration, Effect, Fiber, Option, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { expect } from "vitest"
import type { Usage } from "../domain/Items.js"
import { TurnEvent } from "../domain/Turn.js"
import {
  type MetricEvent,
  type Throughput,
  type TimeToCompletion,
  type TimeToFirstToken,
  type TokenTotals,
  computeThroughputTick,
  isMetricEvent,
  makeEvent,
  metricEvents,
  throughput,
  timeToCompletion,
  timeToFirstToken,
  tokenTotals,
} from "./Metrics.js"

const turnComplete = (usage: Usage): TurnEvent =>
  TurnEvent.TurnComplete({ turn: { items: [], usage, stop_reason: "stop" } })

const text = (s: string): TurnEvent => TurnEvent.TextDelta({ text: s })

const toolArgs = (s: string): TurnEvent =>
  TurnEvent.ToolCallArgsDelta({ call_id: "call_1", delta: s })

const samples = (events: ReadonlyArray<unknown>): ReadonlyArray<MetricEvent> =>
  events.filter(isMetricEvent)

const head = <A>(xs: ReadonlyArray<A>): A => Option.getOrThrow(Arr.head(xs))

const tagged = <T extends MetricEvent["_tag"]>(
  events: ReadonlyArray<unknown>,
  tag: T,
): ReadonlyArray<Extract<MetricEvent, { readonly _tag: T }>> =>
  samples(events).filter((e): e is Extract<MetricEvent, { readonly _tag: T }> => e._tag === tag)

// A stream that emits each event after the given delay since the previous one.
const timed = <A>(steps: ReadonlyArray<readonly [Duration.Input, A]>): Stream.Stream<A> =>
  Stream.fromIterable(steps).pipe(
    Stream.mapEffect(([delay, ev]) => Effect.as(Effect.sleep(delay), ev)),
  )

// Collect a metered stream while advancing the test clock by each step, so
// every per-event clock read lands at a known virtual time.
const runTimed = <A>(
  metered: Stream.Stream<A>,
  steps: ReadonlyArray<Duration.Input>,
): Effect.Effect<ReadonlyArray<A>> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Stream.runCollect(metered))
    yield* Effect.forEach(steps, (step) => TestClock.adjust(step), { discard: true })
    return yield* Fiber.join(fiber)
  })

describe("tokenTotals", () => {
  it.effect("turn level: a single TurnComplete reports that generation's usage", () =>
    Effect.gen(function* () {
      const stream = Stream.make(
        text("hi"),
        turnComplete({ input_tokens: 100, output_tokens: 20, total_tokens: 120 }),
      )
      const out = yield* Stream.runCollect(stream.pipe(tokenTotals))
      const totals = tagged(out, "TokenTotals") as ReadonlyArray<TokenTotals>
      expect(totals).toHaveLength(1)
      expect(head(totals).turnIndex).toBe(0)
      expect(head(totals).usage.output_tokens).toBe(20)
      expect(head(totals).cumulative.output_tokens).toBe(20)
    }),
  )

  it.effect("loop level: cumulative sums across every turn, usage stays per-turn", () =>
    Effect.gen(function* () {
      const stream = Stream.make(
        text("a"),
        turnComplete({ input_tokens: 1000, output_tokens: 120 }),
        turnComplete({ input_tokens: 1300, output_tokens: 410 }),
      )
      const out = yield* Stream.runCollect(stream.pipe(tokenTotals))
      const totals = tagged(out, "TokenTotals") as ReadonlyArray<TokenTotals>
      expect(totals.map((t) => t.turnIndex)).toEqual([0, 1])
      expect(totals.map((t) => t.usage.output_tokens)).toEqual([120, 410])
      expect(totals.map((t) => t.cumulative.input_tokens)).toEqual([1000, 2300])
      expect(totals.map((t) => t.cumulative.output_tokens)).toEqual([120, 530])
    }),
  )

  it.effect("emits an incremental output_tokens counter measurement per turn", () =>
    Effect.gen(function* () {
      const stream = Stream.make(turnComplete({ output_tokens: 7 }))
      const out = yield* Stream.runCollect(stream.pipe(tokenTotals))
      const m = head(samples(out)).measurements.find((m) => m.name === "effect_uai_output_tokens")
      expect(m).toEqual({ name: "effect_uai_output_tokens", kind: "counter", value: 7 })
    }),
  )
})

describe("timeToFirstToken", () => {
  it.effect("fires on the first content delta, measured from request (stream init)", () =>
    Effect.gen(function* () {
      const stream = timed<TurnEvent>([
        ["300 millis", text("hello")],
        ["700 millis", turnComplete({})],
      ]).pipe(timeToFirstToken())
      const out = yield* runTimed(stream, ["300 millis", "700 millis"])
      const ttft = tagged(out, "TimeToFirstToken") as ReadonlyArray<TimeToFirstToken>
      expect(ttft).toHaveLength(1)
      expect(Duration.toMillis(head(ttft).elapsed)).toBe(300)
      expect(head(ttft).kind).toBe("text")
    }),
  )

  it.effect("reports kind reasoning when reasoning arrives first", () =>
    Effect.gen(function* () {
      const stream = timed<TurnEvent>([
        ["120 millis", TurnEvent.ReasoningDelta({ text: "...", kind: "trace" })],
        ["80 millis", text("answer")],
        ["50 millis", turnComplete({})],
      ]).pipe(timeToFirstToken())
      const out = yield* runTimed(stream, ["120 millis", "80 millis", "50 millis"])
      const ttft = tagged(out, "TimeToFirstToken") as ReadonlyArray<TimeToFirstToken>
      expect(ttft).toHaveLength(1)
      expect(head(ttft).kind).toBe("reasoning")
      expect(Duration.toMillis(head(ttft).elapsed)).toBe(120)
    }),
  )

  it.effect("loop level: one TTFT per turn, turnIndex increments", () =>
    Effect.gen(function* () {
      const stream = timed<TurnEvent>([
        ["200 millis", text("a")],
        ["100 millis", turnComplete({})],
        ["300 millis", text("b")],
        ["100 millis", turnComplete({})],
      ]).pipe(timeToFirstToken())
      const out = yield* runTimed(stream, ["200 millis", "100 millis", "300 millis", "100 millis"])
      const ttft = tagged(out, "TimeToFirstToken") as ReadonlyArray<TimeToFirstToken>
      expect(ttft.map((t) => t.turnIndex)).toEqual([0, 1])
      // turn 0 from init; turn 1 from the previous TurnComplete (loop-scope approximation)
      expect(ttft.map((t) => Duration.toMillis(t.elapsed))).toEqual([200, 300])
    }),
  )
})

describe("timeToCompletion", () => {
  it.effect("reports duration (request->complete) and generation (first token->complete)", () =>
    Effect.gen(function* () {
      const stream = timed<TurnEvent>([
        ["300 millis", text("hi")],
        ["700 millis", turnComplete({})],
      ]).pipe(timeToCompletion)
      const out = yield* runTimed(stream, ["300 millis", "700 millis"])
      const done = tagged(out, "TimeToCompletion") as ReadonlyArray<TimeToCompletion>
      expect(done).toHaveLength(1)
      expect(Duration.toMillis(head(done).duration)).toBe(1000)
      expect(Duration.toMillis(head(done).generation)).toBe(700)
    }),
  )
})

describe("computeThroughputTick", () => {
  const base = {
    units: 0,
    lastUnits: 0,
    lastMillis: 0,
    firstMillis: Option.none<number>(),
    smoothed: Option.none<number>(),
    turnIndex: 0,
  }

  it("returns None before the first token", () => {
    expect(Option.isNone(computeThroughputTick(base, 500, "windowed", undefined))).toBe(true)
  })

  it("windowed: rate is units in the last interval over that interval", () => {
    const state = {
      ...base,
      units: 30,
      lastUnits: 10,
      lastMillis: 500,
      firstMillis: Option.some(100),
    }
    const r = computeThroughputTick(state, 1000, "windowed", undefined)
    // (30 - 10) units over (1000 - 500) ms = 40/s
    expect(Option.getOrThrow(r).rate).toBe(40)
  })

  it("cumulative: rate is total units over time since first token", () => {
    const state = {
      ...base,
      units: 30,
      lastUnits: 10,
      lastMillis: 500,
      firstMillis: Option.some(100),
    }
    const r = computeThroughputTick(state, 1000, "cumulative", undefined)
    // 30 units over (1000 - 100) ms ~= 33.33/s
    expect(Option.getOrThrow(r).rate).toBeCloseTo(33.333, 2)
  })

  it("smooth: blends the instantaneous rate with the carried average", () => {
    const state = {
      ...base,
      units: 20,
      lastUnits: 0,
      lastMillis: 0,
      firstMillis: Option.some(0),
      smoothed: Option.some(100),
    }
    // windowed instant = 20 units / 1000 ms = 20/s; smoothed = 0.5*20 + 0.5*100 = 60
    const r = computeThroughputTick(state, 1000, "windowed", 0.5)
    expect(Option.getOrThrow(r).rate).toBe(60)
  })
})

describe("throughput (metronome)", () => {
  it.effect("emits a live char rate on the tick, over the elapsed window", () =>
    Effect.gen(function* () {
      // 10 chars land at t=0; the source then stays open so the metronome can
      // tick. take(1) ends the stream on the first sample, so termination does
      // not depend on the source closing.
      const source = Stream.make(text("aaaaa"), text("aaaaa")).pipe(
        Stream.concat(timed<TurnEvent>([["10 seconds", turnComplete({})]])),
      )
      const stream = source.pipe(
        throughput({ every: "1 second", unit: "char" }),
        metricEvents,
        Stream.take(1),
      )
      const out = yield* runTimed(stream, ["1 second"])
      const rates = out.filter((e): e is Throughput => e._tag === "Throughput")
      expect(rates).toHaveLength(1)
      expect(head(rates).unit).toBe("char")
      expect(head(rates).turnIndex).toBe(0)
      // exact rate math is pinned by the computeThroughputTick tests; here we
      // only assert the metronome wired a positive char rate onto the tick.
      expect(head(rates).ratePerSecond).toBeGreaterThan(0)
    }),
  )

  it.effect("counts tool-call arguments: a turn with no prose still reports a rate", () =>
    Effect.gen(function* () {
      // The shape of an agent turn that only calls tools. Before output deltas
      // were counted beyond TextDelta this measured 0 for the whole run.
      const source = Stream.make(toolArgs('{"city":'), toolArgs('"Lisbon"}')).pipe(
        Stream.concat(timed<TurnEvent>([["10 seconds", turnComplete({})]])),
      )
      const stream = source.pipe(
        throughput({ every: "1 second", unit: "char" }),
        metricEvents,
        Stream.take(1),
      )
      const out = yield* runTimed(stream, ["1 second"])
      const rates = out.filter((e): e is Throughput => e._tag === "Throughput")
      expect(rates).toHaveLength(1)
      expect(head(rates).ratePerSecond).toBeGreaterThan(0)
    }),
  )

  // Runs on the real clock: this asserts an absence, so there is no sample to
  // wait for and the stream has to end by the source closing. Under TestClock
  // that path does not settle, because the metronome re-arms a sleep that no
  // remaining `adjust` resolves.
  it.live("ignores events that carry no generated output", () =>
    Effect.gen(function* () {
      // ToolCallStart and UsageUpdate are turn bookkeeping, not output.
      const source = Stream.make(
        TurnEvent.ToolCallStart({ call_id: "call_1", name: "get_weather" }),
        TurnEvent.UsageUpdate({ usage: { output_tokens: 5 } }),
      ).pipe(Stream.concat(timed<TurnEvent>([["30 millis", turnComplete({})]])))
      const stream = source.pipe(throughput({ every: "10 millis", unit: "char" }), metricEvents)
      const out = yield* Stream.runCollect(stream)
      // No output delta ever landed, so the accumulator never started and the
      // metronome ticks produce nothing.
      expect(out.filter((e): e is Throughput => e._tag === "Throughput")).toHaveLength(0)
    }),
  )
})

describe("custom events and helpers", () => {
  it("makeEvent stamps the brand so isMetricEvent and the recorder see it", () => {
    const ev = makeEvent({
      _tag: "ToolLatency",
      turnIndex: 0,
      measurements: [{ name: "myapp_tool_latency", kind: "timer", value: Duration.millis(42) }],
    })
    expect(isMetricEvent(ev)).toBe(true)
    expect(isMetricEvent(text("x"))).toBe(false)
    expect(isMetricEvent(turnComplete({}))).toBe(false)
  })

  it.effect("metricEvents projects a mixed stream onto just the samples", () =>
    Effect.gen(function* () {
      const stream = Stream.make(text("hi"), turnComplete({ output_tokens: 3 })).pipe(
        tokenTotals,
        metricEvents,
      )
      const out = yield* Stream.runCollect(stream)
      expect(out.every(isMetricEvent)).toBe(true)
      expect(out.map((e) => e._tag)).toEqual(["TokenTotals"])
    }),
  )
})
