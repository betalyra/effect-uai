/**
 * The contract both sides import: the tools as Schemas only (no `run`, so it
 * is safe in the browser). The server builds its tools from these specs; the
 * client's `Thread` is typed by `ChatUi`, so a tool block narrowed by name
 * has its tool's input and outcome (`observedAt` is a `Date`, a failure is
 * the tool's own error class).
 */
import * as ToolDecision from "@effect-uai/core/ToolDecision"
import * as UiContract from "@effect-uai/ui/UiContract"
import { Schema } from "effect"

export class CityNotFound extends Schema.TaggedError<CityNotFound>()("CityNotFound", {
  city: Schema.String,
}) {}

export class UnknownTimezone extends Schema.TaggedError<UnknownTimezone>()("UnknownTimezone", {
  timezone: Schema.String,
}) {}

/** A waiting call the user moved past by sending a new message. */
export class Superseded extends Schema.TaggedError<Superseded>()("Superseded", {
  message: Schema.String,
}) {}

/** How the app closes a call that needs approval: the user denied it, or moved past it. */
export const Closings = Schema.Union([ToolDecision.Denied, Superseded])

export const GetWeather = {
  name: "get_weather",
  description: "The weather right now in a city, e.g. 'Lisbon' or 'Tokyo'.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({
    city: Schema.String,
    country: Schema.String,
    temperatureC: Schema.Number,
    windSpeedKmh: Schema.Number,
    observedAt: Schema.DateFromString,
  }),
  failureSchema: CityNotFound,
} as const

export const GetDate = {
  name: "get_date",
  description: "The current date and time in an IANA timezone, e.g. 'Europe/Lisbon'.",
  inputSchema: Schema.Struct({ timezone: Schema.String }),
  outputSchema: Schema.Struct({ timezone: Schema.String, now: Schema.DateFromString }),
  failureSchema: UnknownTimezone,
} as const

// The two below need the user's approval before they run (see the server).

export const SendEmail = {
  name: "send_email",
  description: "Send an email. The user approves it before it is sent.",
  inputSchema: Schema.Struct({ to: Schema.String, subject: Schema.String, body: Schema.String }),
  outputSchema: Schema.Struct({ to: Schema.String, sentAt: Schema.DateFromString }),
  failureSchema: Closings,
} as const

export const BookTable = {
  name: "book_table",
  description: "Book a restaurant table. The user approves it before it is booked.",
  inputSchema: Schema.Struct({
    restaurant: Schema.String,
    time: Schema.String,
    guests: Schema.Number,
  }),
  outputSchema: Schema.Struct({
    restaurant: Schema.String,
    time: Schema.String,
    guests: Schema.Number,
  }),
  failureSchema: Closings,
} as const

export const ChatUi = UiContract.make({
  tools: [GetWeather, GetDate, SendEmail, BookTable],
  // Live metrics while an answer streams; the latest value of each wins.
  live: { ttftMs: Schema.Number, tokensPerSecond: Schema.Number },
})
export type ChatPayloads = UiContract.Payloads<typeof ChatUi>
