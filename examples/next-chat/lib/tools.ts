/**
 * The tools: the shared specs from `chat-ui.ts` plus a `run`. Both pages get
 * weather and the date; the main page also gets the two that need approval.
 */
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { DateTime, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { BookTable, CityNotFound, GetDate, GetWeather, SendEmail, UnknownTimezone } from "./chat-ui"

// A tool over a REST API: Open-Meteo (public, no key). Geocode the city, then
// read its current weather; each response is decoded with a Schema.
const Geocoding = Schema.Struct({
  results: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        country: Schema.optional(Schema.String),
        latitude: Schema.Number,
        longitude: Schema.Number,
      }),
    ),
  ),
})

const Forecast = Schema.Struct({
  current: Schema.Struct({ temperature_2m: Schema.Number, wind_speed_10m: Schema.Number }),
})

const getWeather = Tool.make({
  ...GetWeather,
  run: ({ city }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const geo = yield* client
        .get("https://geocoding-api.open-meteo.com/v1/search", {
          urlParams: { name: city, count: 1 },
        })
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Geocoding)))
      const place = geo.results?.[0]
      if (place === undefined) return yield* new CityNotFound({ city })
      const forecast = yield* client
        .get("https://api.open-meteo.com/v1/forecast", {
          urlParams: {
            latitude: place.latitude,
            longitude: place.longitude,
            current: "temperature_2m,wind_speed_10m",
          },
        })
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Forecast)))
      return {
        city: place.name,
        country: place.country ?? "",
        temperatureC: forecast.current.temperature_2m,
        windSpeedKmh: forecast.current.wind_speed_10m,
        observedAt: DateTime.toDate(yield* DateTime.now),
      }
    }),
})

// An unknown timezone fails the call with the declared error; the model sees it and can retry.
const getDate = Tool.make({
  ...GetDate,
  run: ({ timezone }) =>
    Effect.gen(function* () {
      if (Option.isNone(DateTime.zoneMakeNamed(timezone))) {
        return yield* new UnknownTimezone({ timezone })
      }
      return { timezone, now: DateTime.toDate(yield* DateTime.now) }
    }),
})

// Stubs: a real app sends the email and books the table here.
const sendEmail = Tool.make({
  ...SendEmail,
  run: ({ to }) => DateTime.now.pipe(Effect.map((now) => ({ to, sentAt: DateTime.toDate(now) }))),
})

const bookTable = Tool.make({
  ...BookTable,
  run: ({ restaurant, time, guests }) => Effect.succeed({ restaurant, time, guests }),
})

/** The `useChat` page (`/ai-sdk`): no approval flow there, so only the tools that run freely. */
export const basicToolkit = Toolkit.make(getWeather, getDate)

/** The main page: all four; `lib/ui-server.ts` decides which need approval. */
export const toolkit = Toolkit.make(getWeather, getDate, sendEmail, bookTable)
