/**
 * The tools as Schemas only (no `run`), so the browser can import them. Both
 * routes build their tools from these specs; the `/ui` page types its state
 * with `ChatUi`, so a tool block narrowed by name has its tool's output.
 */
import * as UiContract from "@effect-uai/ui/UiContract"
import { Schema } from "effect"

export const GetWeather = {
  name: "get_weather",
  description: "Look up the current weather for a city by name, e.g. 'Lisbon' or 'Tokyo'.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({
    city: Schema.String,
    country: Schema.String,
    temperatureC: Schema.Number,
    windSpeedKmh: Schema.Number,
    observedAt: Schema.Date,
  }),
} as const

export const GetDate = {
  name: "get_date",
  description: "The current date and time in an IANA timezone, e.g. 'Europe/Lisbon'.",
  inputSchema: Schema.Struct({ timezone: Schema.String }),
  outputSchema: Schema.Struct({ timezone: Schema.String, now: Schema.Date }),
} as const

export const ChatUi = UiContract.make({ tools: [GetWeather, GetDate] })
export type ChatPayloads = UiContract.Payloads<typeof ChatUi>
