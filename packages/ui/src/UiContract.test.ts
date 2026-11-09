import * as Approval from "@effect-uai/core/Approval"
import * as Content from "@effect-uai/core/Content"
import { imageBytes } from "@effect-uai/core/Image"
import * as Tool from "@effect-uai/core/Tool"
import * as ToolOutput from "@effect-uai/core/ToolOutput"
import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Effect, Fiber, Option, Result, Schema, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { Atom, AtomRegistry } from "effect/reactivity"
import * as Atoms from "./Atoms.js"
import * as Input from "./Input.js"
import { type Envelope, type Outcome, RunId, type RunEvent, StreamId } from "./RunEvent.js"
import * as RunView from "./RunView.js"
import * as Thread from "./Thread.js"
import * as Transport from "./Transport.js"
import * as UiContract from "./UiContract.js"

class CityNotFound extends Schema.TaggedError<CityNotFound>()("CityNotFound", {
  city: Schema.String,
}) {}

// A shared spec: Schemas only, imported by server and client. It needs approval,
// so the app may close a call with `Denied`.
const GetWeather = {
  name: "get_weather",
  description: "Current weather for a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({ temperatureC: Schema.Number, observedAt: Schema.DateFromString }),
  failureSchema: Schema.Union([CityNotFound, Approval.Denied]),
} as const

type Weather = { readonly temperatureC: number; readonly observedAt: Date }

const Metrics = Schema.Struct({ tokps: Schema.Number, at: Schema.Date })

const ChatUi = UiContract.make({
  tools: [GetWeather],
  live: { metrics: Metrics },
})
type ChatPayloads = UiContract.Payloads<typeof ChatUi>

const initial: RunView.RunView<ChatPayloads> = {
  inputs: [],
  status: "idle",
  blocks: [],
  interrupts: [],
  live: {},
  lastSeq: 0,
  stepStart: 0,
  nextBlock: 0,
}

const at = new Date("2026-11-06T10:00:00.000Z")
const s = StreamId.make("s1")
const r1 = RunId.make("r1")

// What a client reads off the wire: JSON payloads.
const wire = (events: ReadonlyArray<RunEvent>): ReadonlyArray<Envelope> =>
  events.map((event, i) => ({ streamId: s, seq: i + 1, runId: r1, event }))

const started: RunEvent = { type: "run-started", runId: r1, inputs: [], protocol: 2 }
const resultOf = (callId: string, result: Outcome): RunEvent => ({
  type: "tool-result",
  callId,
  name: "get_weather",
  result,
})

const weatherRun: ReadonlyArray<RunEvent> = [
  started,
  { type: "tool-call-ready", callId: "c1", name: "get_weather", input: { city: "Lisbon" } },
  resultOf("c1", {
    _tag: "Success",
    value: { temperatureC: 19.4, observedAt: at.toISOString() },
  }),
  { type: "live", name: "metrics", value: { tokps: 42, at: at.toISOString() } },
  { type: "run-completed" },
]

const fold = (envelopes: ReadonlyArray<Envelope>) =>
  Effect.forEach(envelopes, ChatUi.decode).pipe(
    Effect.map((decoded) => decoded.reduce(RunView.step, initial)),
  )

const toolBlocks = (view: RunView.RunView<ChatPayloads>) =>
  view.blocks.filter((b) => b.type === "tool")

describe("UiContract", () => {
  it.effect("decodes payloads on arrival, so the view holds typed values", () =>
    Effect.gen(function* () {
      const view = yield* fold(wire(weatherRun))
      expect(toolBlocks(view)[0]).toMatchObject({
        status: "done",
        outcome: { _tag: "Success", value: { temperatureC: 19.4, observedAt: at } },
      })
      expect(view.live.metrics).toEqual({ tokps: 42, at })
    }),
  )

  it.effect("decodes the tool's, core's and the app's errors as classes", () =>
    Effect.gen(function* () {
      const view = yield* fold(
        wire([
          started,
          resultOf("c1", { _tag: "Failure", error: { _tag: "CityNotFound", city: "Atlantis" } }),
          resultOf("c2", { _tag: "Failure", error: { _tag: "Denied", message: "not now" } }),
          resultOf("c3", { _tag: "Failure", error: { _tag: "UnknownTool", message: "gone" } }),
        ]),
      )
      const errors = toolBlocks(view).map((b) =>
        b.outcome?._tag === "Failure" ? b.outcome.error : undefined,
      )
      expect(errors.map((e) => e?.constructor.name)).toEqual([
        "CityNotFound",
        "Denied",
        "UnknownTool",
      ])
      expect(toolBlocks(view).map((b) => b.status)).toEqual(["failed", "failed", "failed"])
    }),
  )

  it("types a tool block by its name: input, partial and outcome", () => {
    type Block = Extract<RunView.Block<ChatPayloads>, { type: "tool" }>
    expectTypeOf<Block["name"]>().toEqualTypeOf<"get_weather">()
    expectTypeOf<Block["input"]>().toEqualTypeOf<{ readonly city: string } | undefined>()
    expectTypeOf<Block["partial"]>().toEqualTypeOf<Weather | undefined>()
    expectTypeOf<Block["outcome"]>().toEqualTypeOf<
      Outcome<Weather, CityNotFound | ToolOutput.CoreError | Approval.Denied> | undefined
    >()
  })

  it("the untyped schemas' types and the hand-written types are interchangeable", () => {
    expectTypeOf<typeof RunView.RunView.Type>().toExtend<RunView.RunView>()
    expectTypeOf<RunView.RunView>().toExtend<typeof RunView.RunView.Type>()
  })

  it.effect("keeps a tool the contract doesn't list as JSON", () =>
    Effect.gen(function* () {
      const result: Outcome = { _tag: "Success", value: { anything: [1, 2] } }
      const view = yield* fold(
        wire([started, { type: "tool-result", callId: "c2", name: "newer_tool", result }]),
      )
      expect(view.blocks).toContainEqual(
        expect.objectContaining({ name: "newer_tool", outcome: result }),
      )
    }),
  )

  it.effect("fails an envelope whose listed payload doesn't decode", () =>
    Effect.gen(function* () {
      const [bad] = wire([resultOf("c1", { _tag: "Success", value: { temperatureC: "warm" } })])
      const error = yield* ChatUi.decode(bad!).pipe(Effect.flip)
      expect(error._tag).toBe("SchemaError")
    }),
  )

  it.effect("server: encodes toolkit events and app closings with the same schemas", () =>
    Effect.gen(function* () {
      const events = yield* Effect.all([
        ChatUi.toolEvent({
          _tag: "Partial",
          call_id: "c1",
          tool: "get_weather",
          value: { temperatureC: 18, observedAt: at },
        }),
        ChatUi.toolEvent({
          _tag: "Output",
          call_id: "c1",
          tool: "get_weather",
          result: Result.fail(new CityNotFound({ city: "Atlantis" })),
        }),
        ChatUi.success({ call_id: "c2", name: "get_weather" }, { temperatureC: 1, observedAt: at }),
        ChatUi.failure(
          { call_id: "c3", name: "get_weather" },
          new Approval.Denied({ message: "not now" }),
        ),
      ])
      expect(events).toEqual([
        {
          type: "tool-partial",
          callId: "c1",
          name: "get_weather",
          value: { temperatureC: 18, observedAt: at.toISOString() },
        },
        resultOf("c1", { _tag: "Failure", error: { _tag: "CityNotFound", city: "Atlantis" } }),
        resultOf("c2", {
          _tag: "Success",
          value: { temperatureC: 1, observedAt: at.toISOString() },
        }),
        resultOf("c3", { _tag: "Failure", error: { _tag: "Denied", message: "not now" } }),
      ])

      // What the server encodes, the client decodes back to the same values.
      const view = yield* fold(wire([started, ...events]))
      expect(toolBlocks(view).map((b) => b.outcome)).toEqual([
        { _tag: "Failure", error: new CityNotFound({ city: "Atlantis" }) },
        { _tag: "Success", value: { temperatureC: 1, observedAt: at } },
        { _tag: "Failure", error: new Approval.Denied({ message: "not now" }) },
      ])
    }),
  )

  it.effect("a Content.Value tool's media arrives as a class", () =>
    Effect.gen(function* () {
      const shot = Tool.make({
        name: "shot",
        description: "",
        inputSchema: Tool.noInput,
        outputSchema: Content.Value,
        run: () =>
          Effect.succeed([
            { title: "Home" },
            Content.image(imageBytes(new Uint8Array([1, 2]), "image/png")),
          ]),
      })
      const Ui = UiContract.make({ tools: [shot] })
      const png = Content.image(imageBytes(new Uint8Array([1, 2]), "image/png"))
      const event = yield* Ui.success({ call_id: "c1", name: "shot" }, [{ title: "Home" }, png])
      const [envelope] = wire([JSON.parse(JSON.stringify(event))])
      const decoded = yield* Ui.decode(envelope!)
      const result = decoded.event.type === "tool-result" ? decoded.event.result : undefined
      expect(result).toEqual({ _tag: "Success", value: [{ title: "Home" }, png] })
    }),
  )

  it.effect("JSON that looks like media stays JSON in the browser (from history)", () =>
    Effect.gen(function* () {
      const anything = Tool.make({
        name: "anything",
        description: "",
        inputSchema: Tool.noInput,
        outputSchema: Content.Value,
        run: () => Effect.succeed("x"),
      })
      const Ui = UiContract.make({ tools: [anything] })
      const lookalike = { _tag: "Image", source: { _tag: "url", url: "https://x/cat.png" } }
      const item = yield* ToolOutput.success({ call_id: "c1" }, Content.Value, lookalike)
      const event = yield* Ui.toolOutput(item, "anything")
      const [envelope] = wire([JSON.parse(JSON.stringify(event))])
      const decoded = yield* Ui.decode(envelope!)
      const result = decoded.event.type === "tool-result" ? decoded.event.result : undefined
      expect(result).toEqual({ _tag: "Success", value: lookalike })
      expect(result?._tag === "Success" && result.value).not.toBeInstanceOf(Content.Image)
    }),
  )

  it("type: a spec's schemas must encode to JSON, as history encodes with them", () => {
    UiContract.make({
      // @ts-expect-error Schema.Date encodes to a Date, not JSON
      tools: [{ name: "at", inputSchema: Tool.noInput, outputSchema: Schema.Date }],
    })
    UiContract.make({
      tools: [{ name: "at", inputSchema: Tool.noInput, outputSchema: Schema.DateFromString }],
    })
  })

  it("types a core Tool by its own Output and Failure", () => {
    const tool = Tool.make({
      ...GetWeather,
      run: () => Effect.succeed({ temperatureC: 1, observedAt: at }),
    })
    type Block = Extract<
      RunView.Block<UiContract.PayloadsOf<{ tools: [typeof tool] }>>,
      { type: "tool" }
    >
    expectTypeOf<Block["partial"]>().toEqualTypeOf<Weather | undefined>()
    expectTypeOf<Block["outcome"]>().toEqualTypeOf<
      Outcome<Weather, CityNotFound | Approval.Denied | ToolOutput.CoreError> | undefined
    >()
  })

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
      const state = { ...Thread.presetFor<ChatPayloads>().initial, active: view }
      const encoded = yield* Schema.encodeEffect(Schema.toCodecJson(ChatUi.Thread))(state)
      expect(JSON.stringify(encoded)).toContain(at.toISOString())
    }),
  )
})

describe("Atoms with a contract", () => {
  it.effect("thread state is typed by the contract and holds decoded values", () =>
    Effect.gen(function* () {
      const chat = Atoms.thread({
        contract: ChatUi,
        runtime: Atom.runtime(SecureRandom.layerWebCrypto),
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
      if (tool?.type === "tool" && tool.outcome?._tag === "Success") {
        expectTypeOf(tool.outcome.value).toEqualTypeOf<Weather>()
        expect(tool.outcome.value.observedAt).toEqual(at)
      } else {
        expect.fail("expected a successful get_weather block")
      }
    }),
  )
})
