import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Cause, Context, Effect, Exit, Layer, pipe, Result, Schema, Stream } from "effect"
import { imageBytes } from "../domain/Image.js"
import type { HistoryItem, ToolCall } from "../domain/Items.js"
import type { Turn } from "../domain/Turn.js"
import * as Content from "./Content.js"
import * as Tool from "./Tool.js"
import * as Toolkit from "./Toolkit.js"
import * as ToolOutput from "./ToolOutput.js"

const call = (name: string, id: string, args = "{}"): ToolCall => ({
  type: "function_call",
  call_id: id,
  name,
  arguments: args,
})

const collect = <T extends Toolkit.Toolkit>(
  toolkit: T,
  calls: ReadonlyArray<ToolCall>,
  options?: Toolkit.ExecuteOptions,
) => Stream.runCollect(Toolkit.run(toolkit, calls, options))

// In call order: concurrency 1.
const outcomes = <T extends Toolkit.Toolkit>(toolkit: T, calls: ReadonlyArray<ToolCall>) =>
  Toolkit.run(toolkit, calls, { concurrency: 1 }).pipe(
    Stream.filter(Toolkit.isOutcome),
    Stream.runCollect,
  )

const failureOf = <R extends Result.Result<unknown, unknown>>(
  r: R,
): Extract<R, { readonly _tag: "Failure" }>["failure"] | undefined =>
  r._tag === "Failure" ? r.failure : undefined

class CityNotFound extends Schema.TaggedError<CityNotFound>()("CityNotFound", {
  city: Schema.String,
}) {}
class ApiDown extends Schema.TaggedError<ApiDown>()("ApiDown", {}) {}

const Weather = Schema.Struct({ city: Schema.String, at: Schema.DateFromString })
const at = new Date("2026-01-01T12:00:00.000Z")

const weather = Tool.make({
  name: "weather",
  description: "Weather for a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Weather,
  failureSchema: CityNotFound,
  run: ({ city }) =>
    Effect.gen(function* () {
      if (city === "Atlantis") return yield* new CityNotFound({ city })
      if (city === "down") return yield* new ApiDown()
      if (city === "bug") return yield* Effect.die("defect")
      return { city, at }
    }),
})

const search = Tool.make({
  name: "search",
  description: "Search, reporting hits as it reads pages.",
  inputSchema: Schema.Struct({ query: Schema.String }),
  outputSchema: Schema.Struct({ hits: Schema.Number }),
  run: () => Stream.fromIterable([{ hits: 1 }, { hits: 3 }, { hits: 4 }]),
})

const escalate = Tool.declare({ name: "escalate", description: "", inputSchema: Tool.noInput })

const kit = Toolkit.make(weather, search, escalate)

describe("Toolkit.run", () => {
  it.effect("emits a Stream tool's values as partials and its last value as the result", () =>
    Effect.gen(function* () {
      const events = yield* collect(kit, [call("search", "s1", '{"query":"x"}')])
      expect(events.map((e) => (e._tag === "Partial" ? e.value : e.result))).toEqual([
        { hits: 1 },
        { hits: 3 },
        Result.succeed({ hits: 4 }),
      ])
    }),
  )

  it.effect("hands on decoded values: a DateFromString field stays a Date", () =>
    Effect.gen(function* () {
      const [event] = yield* outcomes(kit, [call("weather", "w1", '{"city":"Lisbon"}')])
      expect(event?.result).toEqual(Result.succeed({ city: "Lisbon", at }))
    }),
  )

  it.effect("a declared error becomes a Failure; an undeclared one fails the stream", () =>
    Effect.gen(function* () {
      const [event] = yield* outcomes(kit, [call("weather", "w1", '{"city":"Atlantis"}')])
      expect(failureOf(event!.result)).toEqual(new CityNotFound({ city: "Atlantis" }))

      const down = yield* Effect.flip(collect(kit, [call("weather", "w2", '{"city":"down"}')]))
      expect(down).toEqual(new ApiDown())

      const bug = yield* Effect.exit(collect(kit, [call("weather", "w3", '{"city":"bug"}')]))
      expect(Exit.isFailure(bug) && Cause.hasDies(bug.cause)).toBe(true)
    }),
  )

  it.effect("reports what it could not run as core errors, without stopping other calls", () =>
    Effect.gen(function* () {
      const events = yield* outcomes(kit, [
        call("weather", "1", '{"city":7}'),
        call("weather", "2", "not json"),
        call("nope", "3"),
        call("escalate", "4"),
        call("constructor", "5"),
        call("search", "6", '{"query":"x"}'),
      ])
      expect(events.map((e) => failureOf(e.result)?._tag)).toEqual([
        "InputInvalid",
        "InputInvalid",
        "UnknownTool",
        "UnknownTool",
        "UnknownTool",
        undefined,
      ])
      expect(failureOf(events[0]!.result)).toMatchObject({
        message: expect.stringContaining("city"),
      })
    }),
  )

  it.effect("reports a value outputSchema rejects, or no value at all, as OutputInvalid", () =>
    Effect.gen(function* () {
      const count = (values: ReadonlyArray<number>) =>
        Tool.make({
          name: "count",
          description: "",
          inputSchema: Tool.noInput,
          outputSchema: Schema.Int,
          run: () => Stream.fromIterable(values),
        })
      const [rejected] = yield* outcomes(Toolkit.make(count([1, 1.5])), [call("count", "1")])
      const [empty] = yield* outcomes(Toolkit.make(count([])), [call("count", "2")])
      expect(failureOf(rejected!.result)).toBeInstanceOf(ToolOutput.OutputInvalid)
      expect(failureOf(empty!.result)).toBeInstanceOf(ToolOutput.OutputInvalid)
    }),
  )

  it("type: events narrow per tool, the stream fails with each tool's undeclared errors", () => {
    const stream = Toolkit.run(kit, [])
    expectTypeOf<Stream.Error<typeof stream>>().toEqualTypeOf<ApiDown>()
    type Done = Extract<
      Stream.Success<typeof stream>,
      { readonly _tag: "Output"; readonly tool: "weather" }
    >
    type Value = Extract<Done["result"], { readonly _tag: "Success" }>["success"]
    type Error = Extract<Done["result"], { readonly _tag: "Failure" }>["failure"]
    expectTypeOf<Value>().toEqualTypeOf<{ readonly city: string; readonly at: Date }>()
    expectTypeOf<Error>().toEqualTypeOf<CityNotFound | ToolOutput.RunError>()
  })

  it("type: an error one tool declares still fails the stream when another throws it", () => {
    const loose = Tool.make({
      name: "loose",
      description: "",
      inputSchema: Tool.noInput,
      run: () => Effect.fail(new CityNotFound({ city: "x" })),
    })
    expectTypeOf<
      Toolkit.ToolkitE<ReturnType<typeof Toolkit.make<[typeof weather, typeof loose]>>>
    >().toEqualTypeOf<ApiDown | CityNotFound>()
  })

  it.effect("provides each tool's own requirements", () =>
    Effect.gen(function* () {
      class Geo extends Context.Service<Geo, { readonly place: string }>()("test/Geo") {}
      const where = Tool.make({
        name: "where",
        description: "",
        inputSchema: Tool.noInput,
        run: () =>
          Effect.gen(function* () {
            return (yield* Geo).place
          }),
      })
      const stream = Toolkit.run(Toolkit.make(where), [call("where", "1")])
      expectTypeOf<Stream.Services<typeof stream>>().toEqualTypeOf<Geo>()
      const [event] = yield* stream.pipe(
        Stream.filter(Toolkit.isOutcome),
        Stream.runCollect,
        Effect.provide(Layer.succeed(Geo, { place: "Lisbon" })),
      )
      expect(event?.result).toEqual(Result.succeed("Lisbon"))
    }),
  )
})

describe("Toolkit.output and Toolkit.decode", () => {
  it.effect("encode with the tool's schemas and decode back to the same typed Result", () =>
    Effect.gen(function* () {
      const events = yield* outcomes(kit, [
        call("weather", "1", '{"city":"Lisbon"}'),
        call("weather", "2", '{"city":"Atlantis"}'),
      ])
      const items = yield* Effect.forEach(events, Toolkit.output(kit))
      expect(items.map((i) => [i.output, i.isError])).toEqual([
        [[{ type: "input_json", value: { city: "Lisbon", at: at.toISOString() } }], undefined],
        [[{ type: "input_json", value: { _tag: "CityNotFound", city: "Atlantis" } }], true],
      ])

      const decoded = yield* Effect.forEach(items, (item) => Toolkit.decode(kit, "weather", item))
      expect(decoded).toEqual(events.map((e) => e.result))
      expectTypeOf(decoded[0]!).toEqualTypeOf<
        Result.Result<
          { readonly city: string; readonly at: Date },
          CityNotFound | ToolOutput.CoreError
        >
      >()
    }),
  )

  it.effect("without outputSchema, media gets its own part and reads back as a class", () =>
    Effect.gen(function* () {
      const png = Content.image(imageBytes(new Uint8Array([1, 2]), "image/png"))
      const shot = Tool.make({
        name: "shot",
        description: "",
        inputSchema: Tool.noInput,
        run: () => Effect.succeed([{ title: "Home" }, png]),
      })
      const shots = Toolkit.make(shot)
      const [event] = yield* outcomes(shots, [call("shot", "1")])
      const item = yield* Toolkit.output(shots, event!)
      expect(item.output.map((p) => p.type)).toEqual(["input_json", "input_image"])
      expect(yield* Toolkit.decode(shots, "shot", item)).toEqual(
        Result.succeed([{ title: "Home" }, png]),
      )
    }),
  )

  it.effect("decodes a call closed with core's Cancelled", () =>
    Effect.gen(function* () {
      const cancelled = new ToolOutput.Cancelled({ message: "user moved on" })
      const item = yield* ToolOutput.failure({ call_id: "1" }, ToolOutput.CoreError, cancelled)
      expect(yield* Toolkit.decode(kit, "weather", item)).toEqual(Result.fail(cancelled))
    }),
  )
})

describe("Toolkit.next", () => {
  it.effect("forwards every event, then continues with the turn and encoded outputs appended", () =>
    Effect.gen(function* () {
      const calls = [
        call("weather", "1", '{"city":"Lisbon"}'),
        call("search", "2", '{"query":"x"}'),
      ]
      const turn: Turn = { items: calls, usage: {}, stop_reason: "tool_calls" }
      const state = { history: [] as ReadonlyArray<HistoryItem>, round: 1 }

      const steps = yield* Toolkit.run(kit, calls, { concurrency: 1 }).pipe(
        Toolkit.next(kit, state, turn),
        Stream.runCollect,
      )
      expect(steps.map((s) => s._tag)).toEqual(["Value", "Value", "Value", "Value", "Next"])

      const last = steps.at(-1)
      expect(last?._tag === "Next" && last.state).toEqual({
        round: 1,
        history: [
          ...calls,
          {
            type: "function_call_output",
            call_id: "1",
            output: [{ type: "input_json", value: { city: "Lisbon", at: at.toISOString() } }],
          },
          {
            type: "function_call_output",
            call_id: "2",
            output: [{ type: "input_json", value: { hits: 4 } }],
          },
        ],
      })
    }),
  )
})

describe("Toolkit.wrap and Toolkit.describeFailures", () => {
  class Audit extends Context.Service<
    Audit,
    { readonly record: (name: string) => Effect.Effect<void> }
  >()("test/Audit") {}
  const audited: Toolkit.Middleware<Audit> = (run, name) => (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* (yield* Audit).record(name)
        return run(input)
      }),
    )

  it.effect("wrap runs local tools through the middleware and tracks its requirement", () =>
    Effect.gen(function* () {
      const recorded: Array<string> = []
      const wrapped = pipe(kit, Toolkit.wrap(audited))
      const stream = Toolkit.run(
        wrapped,
        [call("search", "1", '{"query":"x"}'), call("escalate", "2")],
        { concurrency: 1 },
      )
      expectTypeOf<Stream.Services<typeof stream>>().toEqualTypeOf<Audit>()

      const events = yield* stream.pipe(
        Stream.filter(Toolkit.isOutcome),
        Stream.runCollect,
        Effect.provideService(Audit, { record: (n) => Effect.sync(() => void recorded.push(n)) }),
      )
      expect(recorded).toEqual(["search"])
      expect(events.map((e) => e.result._tag)).toEqual(["Success", "Failure"])
    }),
  )

  it.effect(
    "describeFailures turns undeclared errors into ToolFailed and keeps declared ones",
    () =>
      Effect.gen(function* () {
        const described = Toolkit.describeFailures(kit, (e) => `upstream: ${e._tag}`)
        expectTypeOf<Toolkit.ToolkitE<typeof described>>().toEqualTypeOf<never>()

        const events = yield* outcomes(described, [
          call("weather", "1", '{"city":"down"}'),
          call("weather", "2", '{"city":"Atlantis"}'),
        ])
        expect(events.map((e) => failureOf(e.result))).toEqual([
          new Tool.ToolFailed({ message: "upstream: ApiDown" }),
          new CityNotFound({ city: "Atlantis" }),
        ])
        const item = yield* Toolkit.output(described, events[0]!)
        expect(item.output).toEqual([
          { type: "input_json", value: { _tag: "ToolFailed", message: "upstream: ApiDown" } },
        ])
      }),
  )

  it.effect("describeFailures keeps an error fatal when describe returns undefined", () =>
    Effect.gen(function* () {
      class SessionGone extends Schema.TaggedError<SessionGone>()("SessionGone", {}) {}
      const click = Tool.make({
        name: "click",
        description: "",
        inputSchema: Schema.Struct({ ref: Schema.String }),
        run: ({ ref }) =>
          Effect.gen(function* () {
            if (ref === "gone") return yield* new SessionGone()
            return yield* new ApiDown()
          }),
      })
      const kit = Toolkit.describeFailures(Toolkit.make(click), (e) =>
        e._tag === "ApiDown" ? "the button did nothing" : undefined,
      )
      expectTypeOf<Toolkit.ToolkitE<typeof kit>>().toEqualTypeOf<ApiDown | SessionGone>()

      const [stale] = yield* outcomes(kit, [call("click", "1", '{"ref":"b1"}')])
      expect(failureOf(stale!.result)).toEqual(
        new Tool.ToolFailed({ message: "the button did nothing" }),
      )
      const gone = yield* Effect.flip(collect(kit, [call("click", "2", '{"ref":"gone"}')]))
      expect(gone).toEqual(new SessionGone())
    }),
  )
})

describe("Toolkit.make, namespace and compose", () => {
  const tool = <N extends string>(name: N) =>
    Tool.make({ name, description: "", inputSchema: Tool.noInput, run: () => Effect.succeed(0) })

  it("rejects a duplicate literal name at compile time", () => {
    const a = tool("search")
    const b = Tool.declare({ name: "search", description: "", inputSchema: Tool.noInput })
    // @ts-expect-error Duplicate tool name: search
    Toolkit.make(a, b)
  })

  it.effect("compose fails on a clash between dynamic toolkits, naming both sources", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Toolkit.compose(Toolkit.fromArray([tool("search")]), Toolkit.fromArray([tool("search")])),
      )
      expect(error).toEqual(
        new Toolkit.DuplicateToolName({ name: "search", sources: ["toolkit-0", "toolkit-1"] }),
      )
    }),
  )

  it.effect("namespaced tools compose and run under their prefixed, typed names", () =>
    Effect.gen(function* () {
      const github = Toolkit.makeNamespaced("github", tool("search"))
      const linear = Toolkit.namespace("linear", Toolkit.make(tool("search")))
      expectTypeOf(github.github__search.name).toEqualTypeOf<"github__search">()

      const both = yield* Toolkit.compose(github, linear)
      const [event] = yield* outcomes(both, [call("linear__search", "1")])
      expect(event).toMatchObject({ tool: "linear__search", result: Result.succeed(0) })
    }),
  )
})
