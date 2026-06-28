import { describe, it } from "@effect/vitest"
import { Array as Arr, Duration, Effect, Layer, Metric, Option, Ref, Stream } from "effect"
import { type HttpBody, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { expect } from "vitest"
import { type Measurement, makeEvent } from "./Metrics.js"
import { layerOtlp, record } from "./Telemetry.js"

const event = (measurements: ReadonlyArray<Measurement>) =>
  makeEvent({ _tag: "Test", turnIndex: 0, measurements })

// Each test gets a fresh registry so instruments do not leak across tests.
const isolated = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(self, Metric.MetricRegistry, new Map())

const findById = (snap: ReadonlyArray<Metric.Metric.Snapshot>, id: string) =>
  Option.getOrThrow(Arr.findFirst(snap, (s) => s.id === id))

describe("record", () => {
  it.effect("accumulates a counter measurement across events", () =>
    isolated(
      Effect.gen(function* () {
        const ev = event([{ name: "rec_counter", kind: "counter", value: 5 }])
        yield* Stream.make(ev, ev).pipe(record(), Stream.runDrain)
        const snap = yield* Metric.snapshot
        const c = findById(snap, "rec_counter")
        expect(c.type).toBe("Counter")
        expect((c.state as { readonly count: number }).count).toBe(10)
      }),
    ),
  )

  it.effect("records a timer measurement as a histogram observation", () =>
    isolated(
      Effect.gen(function* () {
        const ev = event([{ name: "rec_timer", kind: "timer", value: Duration.millis(100) }])
        yield* Stream.make(ev).pipe(record(), Stream.runDrain)
        const snap = yield* Metric.snapshot
        const h = findById(snap, "rec_timer")
        expect(h.type).toBe("Histogram")
        expect((h.state as { readonly count: number }).count).toBe(1)
      }),
    ),
  )

  it.effect("applies base attributes to every recorded metric", () =>
    isolated(
      Effect.gen(function* () {
        const ev = event([{ name: "rec_attr", kind: "counter", value: 1 }])
        yield* Stream.make(ev).pipe(
          record({ attributes: { model: "test-model" } }),
          Stream.runDrain,
        )
        const snap = yield* Metric.snapshot
        const c = findById(snap, "rec_attr")
        expect(c.attributes).toMatchObject({ model: "test-model" })
      }),
    ),
  )

  it.effect("records a custom metric with a novel name, unchanged recorder", () =>
    isolated(
      Effect.gen(function* () {
        // A user-defined event the recorder has never seen: still exported.
        const custom = makeEvent({
          _tag: "ToolLatency",
          turnIndex: 0,
          measurements: [{ name: "myapp_tool_latency_total", kind: "counter", value: 3 }],
        })
        yield* Stream.make(custom).pipe(record(), Stream.runDrain)
        const snap = yield* Metric.snapshot
        const c = findById(snap, "myapp_tool_latency_total")
        expect((c.state as { readonly count: number }).count).toBe(3)
      }),
    ),
  )

  it.effect("passes non-metric elements through untouched", () =>
    isolated(
      Effect.gen(function* () {
        const out = yield* Stream.make("a", "b", "c").pipe(record(), Stream.runCollect)
        expect(out).toEqual(["a", "b", "c"])
      }),
    ),
  )
})

const bodyToString = (body: HttpBody.HttpBody): string =>
  body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : ""

describe("layerOtlp", () => {
  it.effect("exports recorded metrics over OTLP via a mock HttpClient", () =>
    isolated(
      Effect.gen(function* () {
        const bodies = yield* Ref.make<ReadonlyArray<string>>([])
        const mockClient = HttpClient.make((request) =>
          Ref.update(bodies, (b) => [...b, bodyToString(request.body)]).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))),
          ),
        )
        const clientLayer = Layer.succeed(HttpClient.HttpClient, mockClient)
        const ev = event([{ name: "otlp_export_counter", kind: "counter", value: 3 }])

        // Provide the OTLP layer scoped to the recording program. The exporter
        // flushes on scope close (interval is long, so we rely on the flush).
        yield* Stream.make(ev).pipe(
          record(),
          Stream.runDrain,
          Effect.provide(
            layerOtlp({
              url: "http://localhost:4318/v1/metrics",
              resource: { serviceName: "test-service" },
              exportInterval: "10 minutes",
            }).pipe(Layer.provide(clientLayer)),
          ),
        )

        const captured = yield* Ref.get(bodies)
        expect(captured.length).toBeGreaterThanOrEqual(1)
        expect(captured.join("\n")).toContain("otlp_export_counter")
      }),
    ),
  )
})
