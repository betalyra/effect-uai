import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Match,
  pipe,
  Result,
  Schema,
  Stream,
} from "effect"
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

// A declared tool: the loop handles its calls.
const escalate = Tool.declare({ name: "escalate", description: "", inputSchema: Tool.noInput })

const kit = Toolkit.make(weather, search, escalate)

describe("Toolkit.run", () => {
  it.effect("emits each of a Stream tool's values as a partial, then the last as the result", () =>
    Effect.gen(function* () {
      const events = yield* collect(kit, [call("search", "s1", '{"query":"x"}')])
      expect(events.map((e) => (e._tag === "Partial" ? e.value : e.result))).toEqual([
        { hits: 1 },
        { hits: 3 },
        { hits: 4 },
        Result.succeed({ hits: 4 }),
      ])
    }),
  )

  it.effect("emits a partial as soon as the tool produces it, not when the next arrives", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const slow = Tool.make({
        name: "slow",
        description: "",
        inputSchema: Tool.noInput,
        outputSchema: Schema.String,
        run: () =>
          Stream.concat(
            Stream.succeed("searching..."),
            Stream.fromEffect(Effect.as(Deferred.await(gate), "found")),
          ),
      })
      // The second value waits for the first partial: a delayed partial deadlocks.
      const events = yield* Toolkit.run(Toolkit.make(slow), [call("slow", "1")]).pipe(
        Stream.tap((e) =>
          e._tag === "Partial" && e.value === "searching..."
            ? Deferred.succeed(gate, undefined)
            : Effect.void,
        ),
        Stream.runCollect,
      )
      expect(events.map((e) => (e._tag === "Partial" ? e.value : e.result))).toEqual([
        "searching...",
        "found",
        Result.succeed("found"),
      ])
    }),
  )

  it.effect("an Effect tool emits only its result, also after describeFailures", () =>
    Effect.gen(function* () {
      const lisbon = [call("weather", "w1", '{"city":"Lisbon"}')]
      const plain = yield* collect(kit, lisbon)
      const described = yield* collect(
        Toolkit.describeFailures(kit, () => "failed"),
        lisbon,
      )
      expect(plain.map((e) => e._tag)).toEqual(["Output"])
      expect(described.map((e) => e._tag)).toEqual(["Output"])
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
      outputSchema: Schema.String,
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
        outputSchema: Schema.String,
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

  it.effect("with Content.Value, media gets its own part and reads back as a class", () =>
    Effect.gen(function* () {
      const png = Content.image(imageBytes(new Uint8Array([1, 2]), "image/png"))
      const shot = Tool.make({
        name: "shot",
        description: "",
        inputSchema: Tool.noInput,
        outputSchema: Content.Value,
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

describe("Tool.withFailures and Toolkit.close", () => {
  class Denied extends Schema.TaggedError<Denied>()("Denied", { message: Schema.String }) {}

  // Only the tool that needs approval may be closed with `Denied`.
  const gated = Toolkit.make(Tool.withFailures(weather, Denied), search)
  const denied = new Denied({ message: "not now" })

  it.effect("a closing the tool declares round-trips through history", () =>
    Effect.gen(function* () {
      const closed = yield* Toolkit.close(gated, call("weather", "1"), denied)
      const item = yield* Toolkit.output(gated, closed)
      expect(item.isError).toBe(true)
      expect(yield* Toolkit.decode(gated, "weather", item)).toEqual(Result.fail(denied))
    }),
  )

  it.effect("closing with an error the call's tool doesn't declare fails at close", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(Toolkit.close(gated, call("search", "2"), denied))
      expect(error).toBeInstanceOf(Toolkit.UndeclaredFailure)
      expect(error.tool).toBe("search")
    }),
  )

  it.effect("with the tool's name, close checks the call belongs to that tool", () =>
    Effect.gen(function* () {
      const closed = yield* Toolkit.close(gated, "weather", call("weather", "5"), denied)
      expect(closed.tool).toBe("weather")
      const error = yield* Effect.flip(Toolkit.close(gated, "weather", call("search", "6"), denied))
      expect(error).toBeInstanceOf(Toolkit.UndeclaredFailure)
    }),
  )

  it("type: with the tool's name, the error must be that tool's", () => {
    // @ts-expect-error search declares no Denied, though weather does
    Toolkit.close(gated, "search", call("search", "7"), denied)
  })

  it.effect("core's errors close any call", () =>
    Effect.gen(function* () {
      const cancelled = new ToolOutput.Cancelled({ message: "moved on" })
      const closed = yield* Toolkit.close(gated, call("search", "3"), cancelled)
      expect(closed.result).toEqual(Result.fail(cancelled))
    }),
  )

  it.effect("Toolkit.withFailures declares the closing on every local tool", () =>
    Effect.gen(function* () {
      const all = Toolkit.withFailures(kit, Denied)
      const closed = yield* Toolkit.close(all, call("search", "4"), denied)
      const item = yield* Toolkit.output(all, closed)
      expect(yield* Toolkit.decode(all, "search", item)).toEqual(Result.fail(denied))
    }),
  )

  it.effect("keeps the tool's own failures declared", () =>
    Effect.gen(function* () {
      const [event] = yield* outcomes(gated, [call("weather", "3", '{"city":"Atlantis"}')])
      expect(failureOf(event!.result)).toEqual(new CityNotFound({ city: "Atlantis" }))
    }),
  )

  it("type: close takes only errors the toolkit declares", () => {
    const decoded = Toolkit.decode(gated, "weather", {
      type: "function_call_output",
      call_id: "1",
      output: [],
    })
    expectTypeOf<Effect.Success<typeof decoded>>().toEqualTypeOf<
      Result.Result<
        { readonly city: string; readonly at: Date },
        CityNotFound | Denied | ToolOutput.CoreError
      >
    >()
    // @ts-expect-error ApiDown is no tool's declared failure
    Toolkit.close(gated, call("weather", "4"), new ApiDown())
  })
})

describe("Toolkit.split and Toolkit.complete", () => {
  const askUser = Tool.declare({
    name: "ask_user",
    description: "",
    inputSchema: Schema.Struct({ question: Schema.String }),
    outputSchema: Schema.String,
  })
  const finish = Tool.declare({
    name: "finish",
    description: "",
    inputSchema: Schema.Struct({ report: Schema.String }),
  })
  const agent = Toolkit.make(weather, askUser, finish)
  const turnOf = (...calls: ReadonlyArray<ToolCall>): Turn => ({
    items: calls,
    usage: {},
    stop_reason: "tool_calls",
  })

  it.effect("sorts a turn's calls: run, declared (decoded), invalid (closed)", () =>
    Effect.gen(function* () {
      const { run, declared, invalid } = yield* Toolkit.split(
        agent,
        turnOf(
          call("weather", "1", `{"city":"Lisbon"}`),
          call("ask_user", "2", `{"question":"Which city?"}`),
          call("nope", "3"),
          call("finish", "4", `{}`),
        ),
      )
      expect(run.map((c) => c.call_id)).toEqual(["1", "3"])
      expect(declared).toEqual([
        {
          tool: "ask_user",
          call: call("ask_user", "2", `{"question":"Which city?"}`),
          input: { question: "Which city?" },
        },
      ])
      expect(invalid).toHaveLength(1)
      expect(invalid[0]).toMatchObject({ call_id: "4", tool: "finish" })
      expect(failureOf(invalid[0]!.result)).toBeInstanceOf(ToolOutput.InputInvalid)
    }),
  )

  it.effect("declared calls are typed per tool: an exhaustive Match handles each", () =>
    Effect.gen(function* () {
      const { declared } = yield* Toolkit.split(
        agent,
        turnOf(call("finish", "1", `{"report":"done"}`), call("ask_user", "2", `{"question":"?"}`)),
      )
      const route = Match.type<Toolkit.DeclaredCall<typeof agent>>().pipe(
        Match.discriminatorsExhaustive("tool")({
          ask_user: (c) => `ask ${c.input.question}`,
          finish: (c) => `end ${c.input.report}`,
        }),
      )
      expect(declared.map(route)).toEqual(["end done", "ask ?"])
      Match.type<Toolkit.DeclaredCall<typeof agent>>().pipe(
        // @ts-expect-error finish is not handled
        Match.discriminatorsExhaustive("tool")({ ask_user: () => "ask" }),
      )
      expectTypeOf<Toolkit.DeclaredCall<typeof agent>["tool"]>().toEqualTypeOf<
        "ask_user" | "finish"
      >()
    }),
  )

  it.effect("complete answers a call with a value typed by outputSchema", () =>
    Effect.gen(function* () {
      const answered = yield* Toolkit.complete(agent, "ask_user", call("ask_user", "1"), "Lisbon")
      expect(answered).toEqual({
        _tag: "Output",
        call_id: "1",
        tool: "ask_user",
        result: Result.succeed("Lisbon"),
      })
      const item = yield* Toolkit.output(agent, answered)
      expect(yield* Toolkit.decode(agent, "ask_user", item)).toEqual(Result.succeed("Lisbon"))
    }),
  )

  it.effect("complete fails with UndeclaredFailure for another tool's call", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Toolkit.complete(agent, "ask_user", call("finish", "1"), "Lisbon"),
      )
      expect(error).toMatchObject({ _tag: "UndeclaredFailure", tool: "ask_user" })
    }),
  )

  it("type: complete's value is the tool's output", () => {
    // @ts-expect-error ask_user's outputSchema is String
    Toolkit.complete(agent, "ask_user", call("ask_user", "1"), 42)
    // @ts-expect-error finish has no outputSchema: nothing to complete with
    Toolkit.complete(agent, "finish", call("finish", "1"), "done")
  })
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
      // weather: Output; search: three partials and its Output.
      expect(steps.map((s) => s._tag)).toEqual([
        "Value",
        "Value",
        "Value",
        "Value",
        "Value",
        "Next",
      ])

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

  it.effect("wrap keeps each tool's shape: an Effect tool emits no partials", () =>
    Effect.gen(function* () {
      const wrapped = pipe(kit, Toolkit.wrap(audited))
      const events = yield* Toolkit.run(
        wrapped,
        [call("weather", "1", '{"city":"Lisbon"}'), call("search", "2", '{"query":"x"}')],
        { concurrency: 1 },
      ).pipe(Stream.runCollect, Effect.provideService(Audit, { record: () => Effect.void }))
      expect(events.map((e) => `${e.tool}:${e._tag}`)).toEqual([
        "weather:Output",
        "search:Partial",
        "search:Partial",
        "search:Partial",
        "search:Output",
      ])
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
        outputSchema: Schema.String,
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
    Tool.make({
      name,
      description: "",
      inputSchema: Tool.noInput,
      outputSchema: Schema.Number,
      run: () => Effect.succeed(0),
    })

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
