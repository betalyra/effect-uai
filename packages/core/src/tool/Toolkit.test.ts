import { describe, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Option, pipe, Schema, Stream } from "effect"
import { expect, expectTypeOf } from "vitest"
import * as AiError from "../domain/AiError.js"
import type { ToolCall } from "../domain/Items.js"
import { type ToolEvent, isOutput, isProgress } from "./ToolEvent.js"
import { isFailure, isOk, toToolCallOutput } from "./ToolResult.js"
import * as Tool from "./Tool.js"
import * as Toolkit from "./Toolkit.js"

const Empty = Schema.Struct({})
const toolCall = (name: string, id: string, args = "{}"): ToolCall => ({
  type: "function_call",
  call_id: id,
  name,
  arguments: args,
})
const runToArray = <T extends Toolkit.Toolkit>(
  toolkit: T,
  calls: ReadonlyArray<ToolCall>,
  options?: Toolkit.ExecuteOptions,
) =>
  Toolkit.run(toolkit, calls, options).pipe(
    Stream.runCollect,
    Effect.map((events): ReadonlyArray<ToolEvent> => Array.from(events)),
  )
// The result of the first terminal Output event (fails the test if there is none).
const firstResult = <T extends Toolkit.Toolkit>(toolkit: T, call: ToolCall) =>
  Toolkit.run(toolkit, [call]).pipe(
    Stream.filter(isOutput),
    Stream.runHead,
    Effect.map((event) => Option.getOrThrow(event).result),
  )

describe("Tool.toDescriptors", () => {
  const GetWeatherInput = Schema.Struct({ city: Schema.String })

  const getWeather = Tool.make({
    name: "get_weather",
    description: "Look up the current temperature for a city.",
    inputSchema: Tool.fromEffectSchema(GetWeatherInput),
    run: ({ city }) => Effect.succeed({ city, tempC: 18 }),
  })

  it("renders the input schema as a JSON Schema document", () => {
    const [desc] = Tool.toDescriptors([getWeather])
    expect(desc?.name).toBe("get_weather")
    expect(desc?.description).toBe("Look up the current temperature for a city.")
    expect(desc?.inputSchema).toMatchObject({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    })
  })

  it("includes strict flag only when set on the tool", () => {
    const strictTool = Tool.make({
      name: "strict_one",
      description: "",
      inputSchema: Tool.fromEffectSchema(GetWeatherInput),
      run: () => Effect.succeed({}),
      strict: true,
    })
    const looseTool = Tool.make({
      name: "loose_one",
      description: "",
      inputSchema: Tool.fromEffectSchema(GetWeatherInput),
      run: () => Effect.succeed({}),
    })
    const [s, l] = Tool.toDescriptors([strictTool, looseTool])
    expect(s?.strict).toBe(true)
    expect(l).not.toHaveProperty("strict")
  })
})

describe("Toolkit.run - tools with R requirements", () => {
  // Two distinct services, modelling the "typed per-tool context" use case
  // (cf. AI SDK 7's `toolsContext`). In Effect each tool declares its R, the
  // compiler enforces it, and `run` surfaces the union for the caller
  // to provide via Layer.
  type WeatherApiKeyShape = { readonly key: string }
  class WeatherApiKey extends Context.Service<WeatherApiKey, WeatherApiKeyShape>()(
    "test/WeatherApiKey",
  ) {}

  type GeoApiKeyShape = { readonly key: string }
  class GeoApiKey extends Context.Service<GeoApiKey, GeoApiKeyShape>()("test/GeoApiKey") {}

  const Empty = Schema.Struct({})

  const getWeather = Tool.make({
    name: "get_weather",
    description: "",
    inputSchema: Tool.fromEffectSchema(Empty),
    run: () =>
      Effect.gen(function* () {
        const { key } = yield* WeatherApiKey
        return { source: "weather", key }
      }),
  })

  const getCoords = Tool.make({
    name: "get_coords",
    description: "",
    inputSchema: Tool.fromEffectSchema(Empty),
    run: () =>
      Effect.gen(function* () {
        const { key } = yield* GeoApiKey
        return { source: "geo", key }
      }),
  })

  const call = (name: string, id: string): ToolCall => ({
    type: "function_call",
    call_id: id,
    name,
    arguments: "{}",
  })

  it("propagates each tool's R into the resulting Stream's requirements", () => {
    const stream = Toolkit.run(Toolkit.make(getWeather, getCoords), [])
    expectTypeOf(stream).toEqualTypeOf<
      Stream.Stream<import("./ToolEvent.js").ToolEvent, never, WeatherApiKey | GeoApiKey>
    >()
  })

  it.effect("runs each tool with its own service injected", () =>
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        Layer.succeed(WeatherApiKey, { key: "weather-123" }),
        Layer.succeed(GeoApiKey, { key: "geo-456" }),
      )

      const events = yield* Toolkit.run(Toolkit.make(getWeather, getCoords), [
        call("get_weather", "c1"),
        call("get_coords", "c2"),
      ]).pipe(Stream.runCollect, Effect.provide(layer))

      const outputs = Array.from(events).filter(isOutput)
      const byCall = new Map(outputs.map((e) => [e.result.call_id, e.result]))

      const w = byCall.get("c1")
      const g = byCall.get("c2")
      expect(w !== undefined && isOk(w) && w.value).toEqual({
        source: "weather",
        key: "weather-123",
      })
      expect(g !== undefined && isOk(g) && g.value).toEqual({
        source: "geo",
        key: "geo-456",
      })
    }),
  )

  it.effect(
    "reports non-local kinds as non_local_tool while local calls in the same turn still run",
    () =>
      Effect.gen(function* () {
        const escalate = Tool.signal({
          name: "escalate",
          description: "",
          inputSchema: Tool.fromEffectSchema(Empty),
        })
        const localPlain = Tool.make({
          name: "plain",
          description: "",
          inputSchema: Tool.fromEffectSchema(Empty),
          run: () => Effect.succeed({ ok: true }),
        })

        const events = yield* Toolkit.run(Toolkit.make(localPlain, escalate), [
          call("escalate", "s1"),
          call("plain", "p1"),
          call("ghost", "g1"),
        ]).pipe(Stream.runCollect)
        const byCall = new Map(
          Array.from(events)
            .filter(isOutput)
            .map((e) => [e.result.call_id, e.result] as const),
        )

        // Signal tool: model-visible but no local executor.
        const s = byCall.get("s1")
        expect(s?._tag === "Failure" && s.kind).toBe("non_local_tool")
        // Unknown tool stays distinct from non-local.
        const g = byCall.get("g1")
        expect(g?._tag === "Failure" && g.kind).toBe("unknown_tool")
        // The local call still executed despite the non-local sibling.
        const p = byCall.get("p1")
        expect(p !== undefined && isOk(p) && p.value).toEqual({ ok: true })
      }),
  )

  it("with no service-needing tools, R is never", () => {
    const plain = Tool.make({
      name: "plain",
      description: "",
      inputSchema: Tool.fromEffectSchema(Empty),
      run: () => Effect.succeed(0),
    })
    const stream = Toolkit.run(Toolkit.make(plain), [])
    expectTypeOf(stream).toEqualTypeOf<
      Stream.Stream<import("./ToolEvent.js").ToolEvent, never, never>
    >()
  })
})

describe("Toolkit.make / compose / namespace - uniqueness", () => {
  const Empty = Schema.Struct({})
  const tool = (name: string) =>
    Tool.make({
      name,
      description: "",
      inputSchema: Tool.fromEffectSchema(Empty),
      run: () => Effect.succeed(0),
    })

  it("rejects a duplicate literal name at compile time", () => {
    const a = tool("search")
    const b = Tool.provider({
      name: "search",
      description: "",
      inputSchema: Tool.fromEffectSchema(Empty),
      provider: "demo",
      config: {},
    })
    // @ts-expect-error Duplicate tool name: search
    Toolkit.make(a, b)
  })

  it.effect("fails compose with DuplicateToolName naming the colliding sources (dynamic)", () =>
    Effect.gen(function* () {
      const github = Toolkit.fromArray([tool("search")])
      const linear = Toolkit.fromArray([tool("search")])
      const exit = yield* Effect.exit(Toolkit.compose(github, linear))
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause)
        expect(json).toContain("DuplicateToolName")
        expect(json).toContain("toolkit-0")
        expect(json).toContain("toolkit-1")
      }
    }),
  )

  it.effect("namespaces names so generic names from two sources compose cleanly", () =>
    Effect.gen(function* () {
      const github = Toolkit.namespace("github", Toolkit.fromArray([tool("search")]))
      const linear = Toolkit.namespace("linear", Toolkit.fromArray([tool("search")]))
      const composed = yield* Toolkit.compose(github, linear)
      expect(Object.keys(composed).sort()).toEqual(["github__search", "linear__search"])
    }),
  )

  it("preserves each tool's R through compose", () => {
    const stream = Effect.gen(function* () {
      const composed = yield* Toolkit.compose(Toolkit.make(tool("a")), Toolkit.make(tool("b")))
      return Toolkit.run(composed, [])
    })
    // No service-needing tools here -> R stays never (compose didn't poison it).
    expectTypeOf(stream).toEqualTypeOf<
      Effect.Effect<
        Stream.Stream<import("./ToolEvent.js").ToolEvent, never, never>,
        Toolkit.DuplicateToolName
      >
    >()
  })
})

describe("Toolkit.namespace - typed toolkits", () => {
  const Query = Schema.Struct({ q: Schema.String })
  type GeoShape = { readonly lookup: (q: string) => Effect.Effect<string> }
  class Geo extends Context.Service<Geo, GeoShape>()("test/Geo") {}

  const search = Tool.make({
    name: "search",
    description: "",
    inputSchema: Tool.fromEffectSchema(Query),
    run: ({ q }) =>
      Effect.gen(function* () {
        const geo = yield* Geo
        if (q === "") return yield* Effect.fail("empty_query" as const)
        return yield* geo.lookup(q)
      }),
  })

  const kit = Toolkit.namespace("geo", Toolkit.make(search))

  it("type: prefixes the name literal of a service-requiring tool", () => {
    expectTypeOf(kit.geo__search.name).toEqualTypeOf<"geo__search">()
  })

  it("type: preserves E and R through namespace", () => {
    expectTypeOf<Toolkit.ToolkitE<typeof kit>>().toEqualTypeOf<"empty_query">()
    expectTypeOf<Toolkit.ToolkitR<typeof kit>>().toEqualTypeOf<Geo>()
  })

  it("type: preserves E and R through makeNamespaced", () => {
    const namespaced = Toolkit.makeNamespaced("geo", search)
    expectTypeOf(namespaced.geo__search.name).toEqualTypeOf<"geo__search">()
    expectTypeOf<Toolkit.ToolkitE<typeof namespaced>>().toEqualTypeOf<"empty_query">()
    expectTypeOf<Toolkit.ToolkitR<typeof namespaced>>().toEqualTypeOf<Geo>()
  })

  it("type: Toolkit.run surfaces the namespaced tool's R (string E is absorbed)", () => {
    const stream = Toolkit.run(kit, [])
    expectTypeOf(stream).toEqualTypeOf<
      Stream.Stream<import("./ToolEvent.js").ToolEvent, never, Geo>
    >()
  })

  it.effect("runtime: renames the tool and executes it under the prefixed name", () =>
    Effect.gen(function* () {
      const call: ToolCall = {
        type: "function_call",
        call_id: "call_1",
        name: "geo__search",
        arguments: '{"q":"lisbon"}',
      }
      const events = yield* Stream.runCollect(Toolkit.run(kit, [call])).pipe(
        Effect.provide(Layer.succeed(Geo, { lookup: (q) => Effect.succeed(`geo:${q}`) })),
      )
      const outputs = events.filter(isOutput).map((e) => e.result)
      expect(outputs).toHaveLength(1)
      expect(outputs[0]).toMatchObject({ _tag: "Ok", tool: "geo__search", value: "geo:lisbon" })
    }),
  )
})

describe("Toolkit.wrap - middleware", () => {
  const Empty = Schema.Struct({})
  type AuditShape = { readonly record: (name: string) => Effect.Effect<void> }
  class Audit extends Context.Service<Audit, AuditShape>()("test/Audit") {}

  const getWeather = Tool.make({
    name: "get_weather",
    description: "",
    inputSchema: Tool.fromEffectSchema(Empty),
    run: () => Effect.succeed({ tempC: 18 }),
  })
  const escalate = Tool.signal({
    name: "escalate",
    description: "",
    inputSchema: Tool.fromEffectSchema(Empty),
  })

  // A middleware that needs the Audit service -> R2 = Audit.
  const audited: Toolkit.Middleware<Audit> = (run, name) => (input, emit) =>
    Effect.gen(function* () {
      const a = yield* Audit
      yield* a.record(name)
      return yield* run(input, emit)
    })

  const call = (name: string, id: string): ToolCall => ({
    type: "function_call",
    call_id: id,
    name,
    arguments: "{}",
  })

  it("unions the middleware's R2 into the toolkit's requirements", () => {
    const wrapped = Toolkit.wrap(Toolkit.make(getWeather), audited)
    const stream = Toolkit.run(wrapped, [])
    expectTypeOf(stream).toEqualTypeOf<
      Stream.Stream<import("./ToolEvent.js").ToolEvent, never, Audit>
    >()
  })

  it.effect("runs the wrapped handler and leaves non-local kinds untouched", () =>
    Effect.gen(function* () {
      const recorded: Array<string> = []
      const wrapped = pipe(Toolkit.make(getWeather, escalate), Toolkit.wrap(audited))

      const events = yield* Toolkit.run(wrapped, [
        call("get_weather", "w1"),
        call("escalate", "s1"),
      ]).pipe(
        Stream.runCollect,
        Effect.provideService(Audit, { record: (n) => Effect.sync(() => void recorded.push(n)) }),
      )
      const byCall = new Map(
        Array.from(events)
          .filter(isOutput)
          .map((e) => [e.result.call_id, e.result] as const),
      )

      // Local tool ran through the middleware (audit fired).
      expect(recorded).toEqual(["get_weather"])
      const w = byCall.get("w1")
      expect(w !== undefined && isOk(w) && w.value).toEqual({ tempC: 18 })
      // Signal kind is left alone by wrap -> still reported non-local.
      const s = byCall.get("s1")
      expect(s?._tag === "Failure" && s.kind).toBe("non_local_tool")
    }),
  )
})

describe("Toolkit.run - executor outcomes", () => {
  const plain = <N extends string>(name: N, out: unknown) =>
    Tool.make({
      name,
      description: "",
      inputSchema: Tool.fromEffectSchema(Empty),
      run: () => Effect.succeed(out),
    })

  it.effect("absorbs a bare string failure as a tool_failed result", () =>
    Effect.gen(function* () {
      const t = Tool.make({
        name: "t",
        description: "",
        inputSchema: Tool.fromEffectSchema(Empty),
        run: () => Effect.fail("nope"),
      })
      const result = yield* firstResult(Toolkit.make(t), toolCall("t", "1"))
      expect(result).toMatchObject({ _tag: "Failure", kind: "tool_failed", reason: "nope" })
    }),
  )

  it.effect("absorbs Tool.fail with a custom kind", () =>
    Effect.gen(function* () {
      const t = Tool.make({
        name: "t",
        description: "",
        inputSchema: Tool.fromEffectSchema(Empty),
        run: () => Tool.fail("missing", { kind: "not_found" }),
      })
      const result = yield* firstResult(Toolkit.make(t), toolCall("t", "1"))
      expect(result).toMatchObject({ _tag: "Failure", kind: "not_found", reason: "missing" })
    }),
  )

  it.effect("propagates a typed non-sentinel failure on the stream", () =>
    Effect.gen(function* () {
      const t = Tool.make({
        name: "t",
        description: "",
        inputSchema: Tool.fromEffectSchema(Empty),
        run: () => Effect.fail(new AiError.RateLimited({ provider: "x", raw: null })),
      })
      const exit = yield* Effect.exit(runToArray(Toolkit.make(t), [toolCall("t", "1")]))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("dies on a defect instead of masking it as a result", () =>
    Effect.gen(function* () {
      const t = Tool.make({
        name: "t",
        description: "",
        inputSchema: Tool.fromEffectSchema(Empty),
        run: () => Effect.die(new Error("boom")),
      })
      const exit = yield* Effect.exit(runToArray(Toolkit.make(t), [toolCall("t", "1")]))
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.effect("streams progress events strictly before the terminal output", () =>
    Effect.gen(function* () {
      const t = Tool.make({
        name: "t",
        description: "",
        inputSchema: Tool.fromEffectSchema(Empty),
        run: (_input, emit) =>
          emit("a").pipe(Effect.andThen(emit("b")), Effect.andThen(Effect.succeed("done"))),
      })
      const events = yield* runToArray(Toolkit.make(t), [toolCall("t", "1")])
      expect(events.map((e) => e._tag)).toEqual(["Progress", "Progress", "Output"])
      expect(events.filter(isProgress).map((p) => p.data)).toEqual(["a", "b"])
    }),
  )

  it.effect("reports input validation failures as a result carrying the issue detail", () =>
    Effect.gen(function* () {
      const t = Tool.make({
        name: "t",
        description: "",
        inputSchema: Tool.fromEffectSchema(Schema.Struct({ x: Schema.Number })),
        run: () => Effect.succeed(1),
      })
      const result = yield* firstResult(Toolkit.make(t), toolCall("t", "1", '{"x":"nope"}'))
      expect(result).toMatchObject({ _tag: "Failure", kind: "input_validation_error" })
      expect(isFailure(result) && result.reason).toBeTruthy()
    }),
  )

  it.effect("normalizes empty arguments to {} for a zero-arg tool", () =>
    Effect.gen(function* () {
      const result = yield* firstResult(Toolkit.make(plain("t", "ok")), toolCall("t", "1", ""))
      expect(result).toMatchObject({ _tag: "Ok", value: "ok" })
    }),
  )

  it.effect("reports unparseable arguments as input_validation_error", () =>
    Effect.gen(function* () {
      const result = yield* firstResult(
        Toolkit.make(plain("t", "ok")),
        toolCall("t", "1", "not json"),
      )
      expect(result).toMatchObject({ _tag: "Failure", kind: "input_validation_error" })
    }),
  )

  it.effect("a call named constructor is unknown_tool, not non_local_tool", () =>
    Effect.gen(function* () {
      const result = yield* firstResult(
        Toolkit.make(plain("t", "ok")),
        toolCall("constructor", "1"),
      )
      expect(result).toMatchObject({ _tag: "Failure", kind: "unknown_tool" })
    }),
  )

  it.effect('serializes an undefined output as "null" on the wire', () =>
    Effect.gen(function* () {
      const t = Tool.make({
        name: "t",
        description: "",
        inputSchema: Tool.fromEffectSchema(Empty),
        run: () => Effect.void,
      })
      const result = yield* firstResult(Toolkit.make(t), toolCall("t", "1"))
      expect(toToolCallOutput(result).output).toBe("null")
    }),
  )

  it.effect("preserves call order with concurrency 1", () =>
    Effect.gen(function* () {
      const kit = Toolkit.make(plain("a", "A"), plain("b", "B"))
      const events = yield* runToArray(kit, [toolCall("a", "a1"), toolCall("b", "b1")], {
        concurrency: 1,
      })
      expect(events.filter(isOutput).map((e) => e.result.call_id)).toEqual(["a1", "b1"])
    }),
  )

  it("type: run of a describeFailures toolkit has no stream error", () => {
    const t = Tool.make({
      name: "t",
      description: "",
      inputSchema: Tool.fromEffectSchema(Empty),
      run: () => Effect.fail(new AiError.RateLimited({ provider: "x", raw: null })),
    })
    const kit = Toolkit.describeFailures(Toolkit.make(t), AiError.describe)
    const stream = Toolkit.run(kit, [])
    expectTypeOf(stream).toEqualTypeOf<Stream.Stream<ToolEvent, never, never>>()
  })

  it("type: run of a typed toolkit propagates the tool's E", () => {
    const t = Tool.make({
      name: "t",
      description: "",
      inputSchema: Tool.fromEffectSchema(Empty),
      run: () => Effect.fail(new AiError.RateLimited({ provider: "x", raw: null })),
    })
    const stream = Toolkit.run(Toolkit.make(t), [])
    expectTypeOf(stream).toEqualTypeOf<Stream.Stream<ToolEvent, AiError.RateLimited, never>>()
  })
})

describe("Tool outputSchema", () => {
  // A shared spec: schemas only, spread into `Tool.make` next to a server-side `run`.
  const GetWeather = {
    name: "get_weather",
    description: "Current weather for a city.",
    inputSchema: Schema.Struct({ city: Schema.String }),
    outputSchema: Schema.Struct({
      city: Schema.String,
      temperatureC: Schema.Number.pipe(Schema.check(Schema.isGreaterThan(-100))),
      observedAt: Schema.Date,
    }),
  } as const
  const lisbon = toolCall("get_weather", "1", `{"city":"Lisbon"}`)

  it.effect("encodes the output through the schema before it reaches the wire", () =>
    Effect.gen(function* () {
      const tool = Tool.make({
        ...GetWeather,
        run: ({ city }) =>
          Effect.succeed({
            city,
            temperatureC: 19.4,
            observedAt: new Date("2026-11-06T10:00:00Z"),
          }),
      })
      const result = yield* firstResult(Toolkit.make(tool), lisbon)
      expect(isOk(result)).toBe(true)
      expect(JSON.parse(toToolCallOutput(result).output)).toEqual({
        city: "Lisbon",
        temperatureC: 19.4,
        observedAt: "2026-11-06T10:00:00.000Z",
      })
    }),
  )

  it.effect("reports output the schema rejects as an output_validation_error result", () =>
    Effect.gen(function* () {
      const tool = Tool.make({
        ...GetWeather,
        run: ({ city }) => Effect.succeed({ city, temperatureC: -273, observedAt: new Date() }),
      })
      const result = yield* firstResult(Toolkit.make(tool), lisbon)
      expect(result).toMatchObject({ _tag: "Failure", kind: "output_validation_error" })
    }),
  )

  it.effect("withRun drops the schema, so a mock's different output passes through", () =>
    Effect.gen(function* () {
      const real = Tool.make({
        ...GetWeather,
        run: ({ city }) => Effect.succeed({ city, temperatureC: 1, observedAt: new Date() }),
      })
      const mock = Tool.withRun(real, () => Effect.succeed({ status: "dry-run" }))
      const result = yield* firstResult(Toolkit.make(mock), lisbon)
      expect(JSON.parse(toToolCallOutput(result).output)).toEqual({ status: "dry-run" })
    }),
  )

  it("types run's return value from the output schema", () => {
    Tool.make({
      ...GetWeather,
      // @ts-expect-error: observedAt must be a Date, not a string
      run: ({ city }) => Effect.succeed({ city, temperatureC: 1, observedAt: "now" }),
    })
    const tool = Tool.make({
      ...GetWeather,
      run: ({ city }) => Effect.succeed({ city, temperatureC: 1, observedAt: new Date() }),
    })
    expectTypeOf(tool.run).returns.toEqualTypeOf<
      Effect.Effect<{
        readonly city: string
        readonly temperatureC: number
        readonly observedAt: Date
      }>
    >()
  })
})
