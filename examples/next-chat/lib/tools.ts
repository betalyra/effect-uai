/**
 * The tools both routes run: the shared specs from `chat-ui.ts` plus a `run`.
 * Weather comes from Open-Meteo (public, no API key).
 */
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { DateTime, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { GetDate, GetWeather } from "./chat-ui"

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
        .get(
          `https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(city)}`,
        )
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Geocoding)))
      const place = geo.results?.[0]
      if (place === undefined) return yield* Effect.fail(new Error(`Unknown city: ${city}`))
      const forecast = yield* client
        .get(
          `https://api.open-meteo.com/v1/forecast?current=temperature_2m,wind_speed_10m&latitude=${place.latitude}&longitude=${place.longitude}`,
        )
        .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Forecast)))
      return {
        city: place.name,
        country: place.country ?? "",
        temperatureC: forecast.current.temperature_2m,
        windSpeedKmh: forecast.current.wind_speed_10m,
        observedAt: DateTime.toDate(yield* DateTime.now),
      }
    }),
  strict: true,
})

// An unknown timezone fails the call; the model sees the error and can retry.
const getDate = Tool.make({
  ...GetDate,
  run: ({ timezone }) =>
    Option.match(DateTime.zoneMakeNamed(timezone), {
      onNone: () => Effect.fail(new Error(`Unknown IANA timezone: ${timezone}`)),
      onSome: () =>
        DateTime.now.pipe(Effect.map((now) => ({ timezone, now: DateTime.toDate(now) }))),
    }),
  strict: true,
})

export const toolkit = Toolkit.make(getWeather, getDate)
