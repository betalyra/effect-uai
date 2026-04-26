import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Tool from "../src/Tool.js"
import * as Toolkit from "../src/Toolkit.js"

describe("Toolkit.toDescriptors", () => {
  const GetWeatherInput = Schema.Struct({ city: Schema.String })

  const getWeather = Tool.make({
    name: "get_weather",
    description: "Look up the current temperature for a city.",
    inputSchema: Tool.fromEffectSchema(GetWeatherInput),
    run: ({ city }) => Effect.succeed({ city, tempC: 18 }),
  })

  it("renders the input schema as a JSON Schema document", () => {
    const [desc] = Toolkit.toDescriptors(Toolkit.make([getWeather]))
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
    const [s, l] = Toolkit.toDescriptors(Toolkit.make([strictTool, looseTool]))
    expect(s?.strict).toBe(true)
    expect(l).not.toHaveProperty("strict")
  })
})
