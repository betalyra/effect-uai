import { Context, Effect, Layer, Schema, Stream } from "effect";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { FunctionCall } from "../domain/Items.js";
import { isOutput } from "./ToolEvent.js";
import { isValue } from "./Outcome.js";
import * as Tool from "./Tool.js";
import * as Toolkit from "./Toolkit.js";

describe("Toolkit.toDescriptors", () => {
  const GetWeatherInput = Schema.Struct({ city: Schema.String });

  const getWeather = Tool.make({
    name: "get_weather",
    description: "Look up the current temperature for a city.",
    inputSchema: Tool.fromEffectSchema(GetWeatherInput),
    run: ({ city }) => Effect.succeed({ city, tempC: 18 }),
  });

  it("renders the input schema as a JSON Schema document", () => {
    const [desc] = Toolkit.toDescriptors(Toolkit.make([getWeather]));
    expect(desc?.name).toBe("get_weather");
    expect(desc?.description).toBe(
      "Look up the current temperature for a city.",
    );
    expect(desc?.inputSchema).toMatchObject({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
  });

  it("includes strict flag only when set on the tool", () => {
    const strictTool = Tool.make({
      name: "strict_one",
      description: "",
      inputSchema: Tool.fromEffectSchema(GetWeatherInput),
      run: () => Effect.succeed({}),
      strict: true,
    });
    const looseTool = Tool.make({
      name: "loose_one",
      description: "",
      inputSchema: Tool.fromEffectSchema(GetWeatherInput),
      run: () => Effect.succeed({}),
    });
    const [s, l] = Toolkit.toDescriptors(Toolkit.make([strictTool, looseTool]));
    expect(s?.strict).toBe(true);
    expect(l).not.toHaveProperty("strict");
  });
});

describe("Toolkit.executeAll - tools with R requirements", () => {
  // Two distinct services, modelling the "typed per-tool context" use case
  // (cf. AI SDK 7's `toolsContext`). In Effect each tool declares its R, the
  // compiler enforces it, and `executeAll` surfaces the union for the caller
  // to provide via Layer.
  type WeatherApiKeyShape = { readonly key: string };
  class WeatherApiKey extends Context.Service<
    WeatherApiKey,
    WeatherApiKeyShape
  >()("test/WeatherApiKey") {}

  type GeoApiKeyShape = { readonly key: string };
  class GeoApiKey extends Context.Service<GeoApiKey, GeoApiKeyShape>()(
    "test/GeoApiKey",
  ) {}

  const Empty = Schema.Struct({});

  const getWeather = Tool.make({
    name: "get_weather",
    description: "",
    inputSchema: Tool.fromEffectSchema(Empty),
    run: () =>
      Effect.gen(function* () {
        const { key } = yield* WeatherApiKey;
        return { source: "weather", key };
      }),
  });

  const getCoords = Tool.make({
    name: "get_coords",
    description: "",
    inputSchema: Tool.fromEffectSchema(Empty),
    run: () =>
      Effect.gen(function* () {
        const { key } = yield* GeoApiKey;
        return { source: "geo", key };
      }),
  });

  const call = (name: string, id: string): FunctionCall => ({
    type: "function_call",
    call_id: id,
    name,
    arguments: "{}",
  });

  it("propagates each tool's R into the resulting Stream's requirements", () => {
    const stream = Toolkit.executeAll([getWeather, getCoords], []);
    expectTypeOf(stream).toEqualTypeOf<
      Stream.Stream<
        import("./ToolEvent.js").ToolEvent,
        never,
        WeatherApiKey | GeoApiKey
      >
    >();
  });

  it("runs each tool with its own service injected", async () => {
    const layer = Layer.mergeAll(
      Layer.succeed(WeatherApiKey, { key: "weather-123" }),
      Layer.succeed(GeoApiKey, { key: "geo-456" }),
    );

    const program = Toolkit.executeAll(
      [getWeather, getCoords],
      [call("get_weather", "c1"), call("get_coords", "c2")],
    ).pipe(Stream.runCollect, Effect.provide(layer));

    const events = await Effect.runPromise(program);
    const outputs = Array.from(events).filter(isOutput);
    const byCall = new Map(outputs.map((e) => [e.result.call_id, e.result]));

    const w = byCall.get("c1");
    const g = byCall.get("c2");
    expect(w !== undefined && isValue(w) && w.value).toEqual({
      source: "weather",
      key: "weather-123",
    });
    expect(g !== undefined && isValue(g) && g.value).toEqual({
      source: "geo",
      key: "geo-456",
    });
  });

  it("with no service-needing tools, R is never", () => {
    const plain = Tool.make({
      name: "plain",
      description: "",
      inputSchema: Tool.fromEffectSchema(Empty),
      run: () => Effect.succeed(0),
    });
    const stream = Toolkit.executeAll([plain], []);
    expectTypeOf(stream).toEqualTypeOf<
      Stream.Stream<import("./ToolEvent.js").ToolEvent, never, never>
    >();
  });
});
