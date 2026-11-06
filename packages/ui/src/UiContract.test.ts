import * as Tool from "@effect-uai/core/Tool"
import { describe, expectTypeOf, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import { expect } from "vitest"
import * as Atoms from "./Atoms.js"
import * as Input from "./Input.js"
import { type Envelope, type Json, RunId, type RunEvent, StreamId } from "./RunEvent.js"
import * as RunView from "./RunView.js"
import * as Transport from "./Transport.js"
import * as UiContract from "./UiContract.js"

// A shared spec: Schemas only, imported by server and client.
const GetWeather = {
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({ temperatureC: Schema.Number, observedAt: Schema.Date }),
} as const

const Metrics = Schema.Struct({ tokps: Schema.Number, at: Schema.Date })

const ChatUi = UiContract.make({ tools: [GetWeather], live: { metrics: Metrics } })

const at = new Date("2026-11-06T10:00:00.000Z")
const s = StreamId.make("s1")
const r1 = RunId.make("r1")

// What a client reads off the wire: JSON payloads.
const wire = (events: ReadonlyArray<RunEvent>): ReadonlyArray<Envelope> =>
  events.map((event, i) => ({ streamId: s, seq: i + 1, runId: r1, event }))

const weatherRun: ReadonlyArray<RunEvent> = [
  { type: "run-started", runId: r1, messageId: "m1", inputs: [], protocol: 1 },
  { type: "tool-call-ready", callId: "c1", name: "get_weather", input: { city: "Lisbon" } },
  {
    type: "tool-result",
    callId: "c1",
    name: "get_weather",
    output: { temperatureC: 19.4, observedAt: at.toISOString() },
    isError: false,
  },
  { type: "live", name: "metrics", value: { tokps: 42, at: at.toISOString() } },
  { type: "run-completed" },
]

const fold = (envelopes: ReadonlyArray<Envelope>) =>
  Effect.forEach(envelopes, ChatUi.decode).pipe(
    Effect.map((decoded) => decoded.reduce(RunView.step, ChatUi.initial)),
  )

describe("UiContract", () => {
  it.effect("decodes payloads on arrival, so the view holds typed values", () =>
    Effect.gen(function* () {
      const view = yield* fold(wire(weatherRun))
      const tool = view.blocks.find((b) => b.type === "tool")
      expect(tool?.type === "tool" && tool.name === "get_weather" && tool.output).toEqual({
        temperatureC: 19.4,
        observedAt: at,
      })
      expect(view.live.metrics).toEqual({ tokps: 42, at })
    }),
  )

  it("the untyped schemas' types and the hand-written types are interchangeable", () => {
    expectTypeOf<typeof RunView.RunView.Type>().toExtend<RunView.RunView>()
    expectTypeOf<RunView.RunView>().toExtend<typeof RunView.RunView.Type>()
  })

  it("types a tool block by its name: input and output", () => {
    type Tool = Extract<
      RunView.Block<UiContract.PayloadsOf<{ tools: [typeof GetWeather] }>>,
      { type: "tool" }
    >
    expectTypeOf<Tool["name"]>().toEqualTypeOf<"get_weather">()
    expectTypeOf<Tool["input"]>().toEqualTypeOf<{ readonly city: string } | undefined>()
    expectTypeOf<Tool["output"]>().toEqualTypeOf<
      { readonly temperatureC: number; readonly observedAt: Date } | undefined
    >()
  })

  it.effect("keeps a tool the contract doesn't list as JSON", () =>
    Effect.gen(function* () {
      const view = yield* fold(
        wire([
          weatherRun[0]!,
          {
            type: "tool-result",
            callId: "c2",
            name: "newer_tool",
            output: { anything: [1, 2] },
            isError: false,
          },
        ]),
      )
      expect(view.blocks).toContainEqual(
        expect.objectContaining({ name: "newer_tool", output: { anything: [1, 2] } }),
      )
    }),
  )

  it.effect("fails an envelope whose listed payload doesn't decode", () =>
    Effect.gen(function* () {
      const [bad] = wire([
        {
          type: "tool-result",
          callId: "c1",
          name: "get_weather",
          output: { temperatureC: "warm" },
          isError: false,
        },
      ])
      const error = yield* ChatUi.decode(bad!).pipe(Effect.flip)
      expect(error._tag).toBe("SchemaError")
    }),
  )

  it.effect("keeps a tool error apart from the typed output", () =>
    Effect.gen(function* () {
      const view = yield* fold(
        wire([
          weatherRun[0]!,
          {
            type: "tool-result",
            callId: "c1",
            name: "get_weather",
            output: { kind: "denied" },
            isError: true,
          },
        ]),
      )
      expect(view.blocks).toContainEqual(
        expect.objectContaining({ status: "denied", error: { kind: "denied" } }),
      )
    }),
  )

  it.effect("server constructors encode typed values for the wire", () =>
    Effect.gen(function* () {
      const event = yield* ChatUi.live("metrics", { tokps: 42, at })
      expect(event).toEqual({
        type: "live",
        name: "metrics",
        value: { tokps: 42, at: at.toISOString() },
      })
    }),
  )

  it.effect("the Thread schema encodes a typed state back to JSON", () =>
    Effect.gen(function* () {
      const view = yield* fold(wire(weatherRun))
      const state = { ...ChatUi.thread.initial, active: view }
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(ChatUi.Thread))(state)
      expect(JSON.stringify(encoded)).toContain(at.toISOString())
    }),
  )

  it("accepts a core Tool: its input is typed, its output stays JSON", () => {
    const tool = Tool.make({
      ...GetWeather,
      run: () => Effect.succeed({ temperatureC: 1, observedAt: at }),
    })
    type Block = Extract<
      RunView.Block<UiContract.PayloadsOf<{ tools: [typeof tool] }>>,
      { type: "tool" }
    >
    expectTypeOf<Block["input"]>().toEqualTypeOf<{ readonly city: string } | undefined>()
    expectTypeOf<Block["output"]>().toEqualTypeOf<Json | undefined>()
    expect(UiContract.make({ tools: [tool] }).initial.blocks).toEqual([])
  })
})

describe("Atoms with a contract", () => {
  it.effect("thread state is typed by the contract and holds decoded values", () =>
    Effect.gen(function* () {
      const chat = Atoms.thread({
        contract: ChatUi,
        runtime: Atom.runtime(Layer.empty),
        busy: "block",
        transport: Transport.local(() =>
          Stream.fromIterable(weatherRun).pipe(Stream.tap(() => Effect.yieldNow)),
        ),
      })
      const registry = AtomRegistry.make()
      const settled = yield* AtomRegistry.toStream(registry, chat.state).pipe(
        Stream.filter((t) => t.messages.length === 2),
        Stream.runHead,
        Effect.forkChild,
      )
      registry.set(chat.submit, Input.submit("Weather in Lisbon?"))
      const thread = yield* Fiber.join(settled).pipe(Effect.map(Option.getOrThrow))

      const answer = thread.messages[1]
      const tool =
        answer?.role === "assistant"
          ? answer.value.blocks.find((b) => b.type === "tool")
          : undefined
      if (tool?.type === "tool" && tool.name === "get_weather") {
        expectTypeOf(tool.output).toEqualTypeOf<
          { readonly temperatureC: number; readonly observedAt: Date } | undefined
        >()
        expect(tool.output?.observedAt).toEqual(at)
      } else {
        expect.fail("expected the get_weather block")
      }
    }),
  )
})
