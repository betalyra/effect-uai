/**
 * The only effect-uai-specific file in this app. It replaces a typical
 * `streamText(...).toUIMessageStreamResponse()` handler with an effect-uai
 * agent loop, and showcases what the framework gives you for free:
 *
 *   - an agentic tool loop (a keyless Open-Meteo weather tool)
 *   - realistic model fallback (primary -> secondary on retryable failures)
 *   - live throughput metrics (tok/s + TTFT) streamed as AI SDK data parts,
 *     with settled usage as message metadata
 *   - structured mid-stream abort (the client's Stop button interrupts the
 *     provider call via the request's AbortSignal)
 *
 * `app/page.tsx` stays a stock `useChat` client.
 */
import * as Messages from "@effect-uai/ai-sdk/Messages"
import * as UIMessageStream from "@effect-uai/ai-sdk/UIMessageStream"
import * as Items from "@effect-uai/core/Items"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import { loop, next, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as Metrics from "@effect-uai/core/Metrics"
import * as SSE from "@effect-uai/core/SSE"
import * as Tool from "@effect-uai/core/Tool"
import * as ToolEvent from "@effect-uai/core/ToolEvent"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { toToolCallOutput } from "@effect-uai/core/ToolResult"
import * as Turn from "@effect-uai/core/Turn"
import { Duration, Effect, Match, Result, Schema, Stream, pipe } from "effect"
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http"
import { readProvider } from "../../../lib/model"

// ---------------------------------------------------------------------------
// Tool: current weather via Open-Meteo (public, no API key).
// ---------------------------------------------------------------------------

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
  name: "get_weather",
  description: "Look up the current weather for a city by name, e.g. 'Lisbon' or 'Tokyo'.",
  inputSchema: Tool.fromEffectSchema(Schema.Struct({ city: Schema.String })),
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
      }
    }),
  strict: true,
})

const toolkit = Toolkit.make(getWeather)

// ---------------------------------------------------------------------------
// The loop: agentic tool calls, with a realistic model fallback. Each tier is
// tried in order; a retryable failure (RateLimited / Unavailable) advances to
// the next tier on the same history. First clean turn without tool calls ends.
// ---------------------------------------------------------------------------

type Tier = {
  readonly name: string
  readonly model: string
  readonly service: LanguageModelService
}

type State = { readonly history: ReadonlyArray<Items.HistoryItem>; readonly tier: number }

const conversation = (tiers: ReadonlyArray<Tier>, history: ReadonlyArray<Items.HistoryItem>) =>
  pipe(
    { history, tier: 0 } satisfies State,
    loop((state: State) =>
      Effect.gen(function* () {
        const tier = tiers[state.tier]
        if (tier === undefined) return stop()

        const advance = Effect.logWarning(`${tier.name} unavailable, falling back`).pipe(
          Effect.as(next({ ...state, tier: state.tier + 1 })),
        )

        return tier.service
          .streamTurn({ history: state.history, model: tier.model, tools: toolkit })
          .pipe(
            onTurnComplete((turn) =>
              Effect.sync(() => {
                const calls = Turn.getToolCalls(turn)
                if (calls.length === 0) return stop()
                return Toolkit.run(toolkit, calls).pipe(
                  Toolkit.continueWithResults(Toolkit.appendToolResults(state, turn)),
                )
              }),
            ),
            Stream.catchTag("RateLimited", () => Stream.unwrap(advance)),
            Stream.catchTag("Unavailable", () => Stream.unwrap(advance)),
          )
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Metrics -> AI SDK emissions. `allMetrics` passes InteractionEvents through
// and injects MetricEvents; we map those onto transient `data-metrics` parts
// (live tok/s + TTFT badge) and settled `message-metadata` (usage footer).
// ---------------------------------------------------------------------------

const estimateTokens = (event: Turn.TurnEvent): Effect.Effect<number> =>
  Effect.succeed(event._tag === "TextDelta" ? [...event.text].length / 4 : 0)

type Sample =
  | Metrics.TimeToFirstToken
  | Metrics.Throughput
  | Metrics.TokenTotals
  | Metrics.TimeToCompletion

const liveMetric = (data: unknown): UIMessageStream.Emission =>
  UIMessageStream.dataPart("metrics", data, { id: "metrics", transient: true })

const fromMetric = (event: Metrics.MetricEvent): Result.Result<UIMessageStream.Emission, void> =>
  Match.value(event as Sample).pipe(
    Match.tag("TimeToFirstToken", (e) =>
      Result.succeed(liveMetric({ ttftMs: Math.round(Duration.toMillis(e.elapsed)) })),
    ),
    Match.tag("Throughput", (e) =>
      Result.succeed(liveMetric({ tokps: Math.round(e.ratePerSecond) })),
    ),
    Match.tag("TokenTotals", (e) =>
      Result.succeed(UIMessageStream.messageMetadata({ usage: e.usage })),
    ),
    Match.orElse(() => Result.failVoid),
  )

// Normalize the loop's wide event stream into encoder emissions: TurnEvents
// pass through, a tool `Output` becomes a `function_call_output`, tool
// progress/approval are dropped, and metrics become data parts / metadata.
const toEmission = (
  event: Turn.TurnEvent | ToolEvent.ToolEvent | Metrics.MetricEvent,
): Result.Result<UIMessageStream.Emission, void> => {
  if (Metrics.isMetricEvent(event)) return fromMetric(event)
  if (ToolEvent.isOutput(event)) return Result.succeed(toToolCallOutput(event.result))
  if (ToolEvent.isProgress(event) || ToolEvent.isApprovalRequested(event)) return Result.failVoid
  return Result.succeed(event)
}

// ---------------------------------------------------------------------------
// Abort: complete when the client disconnects (useChat's Stop button), so
// `Stream.interruptWhen` tears the loop down and drops the provider request.
// ---------------------------------------------------------------------------

const whenAborted = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void)
    const onAbort = () => resume(Effect.void)
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })

// ---------------------------------------------------------------------------

// The provider comes from the environment (`lib/model.ts`), so the two tiers
// below are one service and two model ids.

const buildStream = (history: ReadonlyArray<Items.HistoryItem>) =>
  Effect.gen(function* () {
    const { fallback, model, service } = yield* readProvider
    const tiers: ReadonlyArray<Tier> = [
      { name: model, model, service },
      { name: fallback, model: fallback, service },
    ]
    return conversation(tiers, history)
  })

export async function POST(request: Request): Promise<Response> {
  const { messages } = await request.json()
  const history = Messages.decodeMessages(messages)

  const events = Stream.unwrap(buildStream(history)).pipe(
    Metrics.allMetrics({
      throughput: { every: "500 millis", unit: "token", tokenizer: estimateTokens },
    }),
    Stream.filterMap(toEmission),
    Stream.interruptWhen(whenAborted(request.signal)),
    Stream.provide(FetchHttpClient.layer),
  )

  const body = events.pipe(
    UIMessageStream.toUIMessageStream(crypto.randomUUID()),
    SSE.toBytes,
    Stream.toReadableStream,
  )
  return new Response(body, { headers: UIMessageStream.responseHeaders })
}
