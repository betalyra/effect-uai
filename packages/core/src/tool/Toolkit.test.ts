import { Context, Effect, Layer, pipe, Schema, Stream } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import type { ToolCall } from "../domain/Items.js"
import { isOutput } from "./ToolEvent.js"
import { isOk } from "./ToolResult.js"
import * as Tool from "./Tool.js"
import * as Toolkit from "./Toolkit.js"

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

  it("runs each tool with its own service injected", async () => {
    const layer = Layer.mergeAll(
      Layer.succeed(WeatherApiKey, { key: "weather-123" }),
      Layer.succeed(GeoApiKey, { key: "geo-456" }),
    )

    const program = Toolkit.run(Toolkit.make(getWeather, getCoords), [
      call("get_weather", "c1"),
      call("get_coords", "c2"),
    ]).pipe(Stream.runCollect, Effect.provide(layer))

    const events = await Effect.runPromise(program)
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
  })

  it("reports non-local kinds as non_local_tool while local calls in the same turn still run", async () => {
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

    const events = await Effect.runPromise(
      Toolkit.run(Toolkit.make(localPlain, escalate), [
        call("escalate", "s1"),
        call("plain", "p1"),
        call("ghost", "g1"),
      ]).pipe(Stream.runCollect),
    )
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
  })

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

  it("throws InvalidToolName for a non-provider-safe first-party name", () => {
    expect(() => Toolkit.make(tool("bad.name"))).toThrow(Toolkit.InvalidToolName)
  })

  it("does not validate provider-defined names (the provider owns them)", () => {
    const dotted = Tool.provider({
      name: "bad.name",
      description: "",
      inputSchema: Tool.fromEffectSchema(Empty),
      provider: "gemini",
      config: {},
    })
    expect(Object.keys(Toolkit.make(dotted))).toEqual(["bad.name"])
  })

  it("fails compose with DuplicateToolName naming the colliding sources (dynamic)", async () => {
    const github = Toolkit.fromArray([tool("search")])
    const linear = Toolkit.fromArray([tool("search")])
    const exit = await Effect.runPromiseExit(Toolkit.compose(github, linear))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const json = JSON.stringify(exit.cause)
      expect(json).toContain("DuplicateToolName")
      expect(json).toContain("toolkit-0")
      expect(json).toContain("toolkit-1")
    }
  })

  it("namespaces names so generic names from two sources compose cleanly", async () => {
    const github = Toolkit.namespace("github", Toolkit.fromArray([tool("search")]))
    const linear = Toolkit.namespace("linear", Toolkit.fromArray([tool("search")]))
    const composed = await Effect.runPromise(Toolkit.compose(github, linear))
    expect(Object.keys(composed).sort()).toEqual(["github__search", "linear__search"])
  })

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

  it("runs the wrapped handler and leaves non-local kinds untouched", async () => {
    const recorded: Array<string> = []
    const wrapped = pipe(Toolkit.make(getWeather, escalate), Toolkit.wrap(audited))

    const events = await Effect.runPromise(
      Toolkit.run(wrapped, [call("get_weather", "w1"), call("escalate", "s1")]).pipe(
        Stream.runCollect,
        Effect.provideService(Audit, { record: (n) => Effect.sync(() => void recorded.push(n)) }),
      ),
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
  })
})
