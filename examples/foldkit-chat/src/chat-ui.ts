/**
 * The contract both sides import: the tools as Schemas only (no `run`, so it
 * is safe in the browser). The server builds its tools from these specs; the
 * client's `Thread` is typed by `ChatUi`, so a tool block narrowed by name
 * has its tool's input and output (`observedAt` is a `Date`).
 */
import * as UiContract from "@effect-uai/ui/UiContract"
import { Schema } from "effect"

export const GetDate = {
  name: "get_date",
  description: "The current date and time in an IANA timezone, e.g. 'Europe/Lisbon'.",
  inputSchema: Schema.Struct({ timezone: Schema.String }),
  outputSchema: Schema.Struct({ timezone: Schema.String, now: Schema.Date }),
} as const

export const GetWeather = {
  name: "get_weather",
  description: "The weather right now in a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({
    city: Schema.String,
    temperatureC: Schema.Number,
    sky: Schema.Literals(["sunny", "cloudy", "rainy"]),
    observedAt: Schema.Date,
  }),
} as const

export const ChatUi = UiContract.make({ tools: [GetDate, GetWeather] })
export type ChatPayloads = UiContract.Payloads<typeof ChatUi>
