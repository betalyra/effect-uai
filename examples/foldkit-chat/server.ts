/**
 * The chat server: `POST /api/chat { chatId?, input }` answers with the run as
 * SSE. One request per message; the server keeps the history. The chat id is
 * the envelopes' `streamId`, so the page learns it from the first answer and
 * sends it back. In memory.
 *
 * An Effect `HttpServer` on :4321; Vite proxies `/api` to it. A closed request
 * interrupts the run.
 */
import { createServer } from "node:http"
import * as Approval from "@effect-uai/core/Approval"
import * as Items from "@effect-uai/core/Items"
import type { ToolCall } from "@effect-uai/core/Items"
import { type LanguageModel, streamTurn } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop, value } from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import * as ToolOutput from "@effect-uai/core/ToolOutput"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import * as Metrics from "@effect-uai/core/Metrics"
import * as Responses from "@effect-uai/responses/Responses"
import * as Input from "@effect-uai/ui/Input"
import * as Projection from "@effect-uai/ui/Projection"
import * as Run from "@effect-uai/ui/Run"
import { RunId, type RunEvent, StreamId } from "@effect-uai/ui/RunEvent"
import * as SseEncoding from "@effect-uai/ui/SseEncoding"
import { NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import {
  Array as Arr,
  Config,
  Data,
  DateTime,
  Duration,
  Effect,
  HashMap,
  HashSet,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import {
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import {
  BookTable,
  ChatUi,
  CityNotFound,
  Closings,
  GetDate,
  GetWeather,
  SendEmail,
  Superseded,
  UnknownTimezone,
} from "./src/chat-ui.ts"

const MODEL = "gpt-5.6-luna"

// TOOLS: the shared specs plus a `run`

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

// Stubs: a real app sends the email and books the table here.
const sendEmail = Tool.make({
  ...SendEmail,
  run: ({ to }) => DateTime.now.pipe(Effect.map((now) => ({ to, sentAt: DateTime.toDate(now) }))),
})

const bookTable = Tool.make({
  ...BookTable,
  run: ({ restaurant, time, guests }) => Effect.succeed({ restaurant, time, guests }),
})

const toolkit = Toolkit.make(getDate, getWeather, sendEmail, bookTable)

// APPROVAL POLICY: plain functions, change them freely

/** Calls that need the user's yes before they run. */
const needsApproval = (call: ToolCall): boolean =>
  call.name === SendEmail.name || call.name === BookTable.name

/**
 * What a new message does to a call still waiting for approval: `deny` it, or
 * `keep` it open so the user can approve it after a follow-up question.
 */
const onFollowUp = (call: ToolCall): "deny" | "keep" =>
  call.name === SendEmail.name ? "keep" : "deny"

// AGENT: model turns until it stops calling tools, or calls one that needs approval

type History = ReadonlyArray<Items.HistoryItem>

const agent = (history: History, parked: Ref.Ref<ReadonlyArray<ToolCall>>) =>
  loop(({ history }: { readonly history: History }) =>
    streamTurn({ history, model: MODEL, tools: toolkit }).pipe(
      onTurnComplete((turn) =>
        Effect.gen(function* () {
          const calls = Turn.getToolCalls(turn)
          if (calls.length === 0) return stop()
          const gated = calls.filter(needsApproval)
          if (gated.length === 0) {
            return Toolkit.run(toolkit, calls).pipe(Toolkit.next(toolkit, { history }, turn))
          }
          // Run the calls that need no approval, park the rest, and end the run.
          yield* Ref.set(parked, gated)
          return Toolkit.run(
            toolkit,
            calls.filter((call) => !needsApproval(call)),
          ).pipe(Stream.map(value), Stream.concat(stop()))
        }),
      ),
    ),
  )({ history })

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

// The run's terminal when calls were parked: the page shows them as awaiting approval.
const interrupted = (calls: ReadonlyArray<ToolCall>): RunEvent => ({
  type: "run-interrupted",
  interrupts: calls.map((call) => ({
    callId: call.call_id,
    reason: "approval",
    name: call.name,
    input: Option.getOrElse(parseJson(call.arguments), () => call.arguments),
  })),
})

// A call the app closes itself; the gated tools declare `Closings` in their `failureSchema`.
const close = (call: ToolCall, error: typeof Closings.Type) => Toolkit.close(toolkit, call, error)

// What one loop event adds to the chat's history: the turn's items, a tool's output.
const historyOf = (source: Projection.Source): Effect.Effect<History, Schema.SchemaError> => {
  if (Items.isToolCallOutput(source)) return Effect.succeed([source])
  if (Turn.isTurnComplete(source)) return Effect.succeed(source.turn.items)
  if (Toolkit.isOutcome(source)) return Effect.map(Toolkit.output(toolkit, source), Arr.of)
  return Effect.succeed([])
}

// METRICS: time to first token and throughput, sent as the contract's `live` values

const estimateTokens = (event: Turn.TurnEvent): Effect.Effect<number> =>
  Effect.succeed(event._tag === "TextDelta" ? [...event.text].length / 4 : 0)

const isFirstToken = (e: Metrics.MetricEvent): e is Metrics.TimeToFirstToken =>
  e._tag === "TimeToFirstToken"
const isThroughput = (e: Metrics.MetricEvent): e is Metrics.Throughput => e._tag === "Throughput"

const liveMetric = (
  event: Metrics.MetricEvent,
): Effect.Effect<ReadonlyArray<RunEvent>, Schema.SchemaError> => {
  if (isFirstToken(event) && event.kind === "text") {
    return ChatUi.live("ttftMs", Math.round(Duration.toMillis(event.elapsed))).pipe(
      Effect.map(Arr.of),
    )
  }
  if (isThroughput(event)) {
    return ChatUi.live("tokensPerSecond", Math.round(event.ratePerSecond)).pipe(Effect.map(Arr.of))
  }
  return Effect.succeed([])
}

// The loop's events go through `Projection`; metric samples become `live` events.
const toRunEvents = <E, R>(self: Stream.Stream<Projection.Source | Metrics.MetricEvent, E, R>) =>
  self.pipe(
    Stream.mapAccumEffect(
      () => Projection.initial,
      (state, event) =>
        Metrics.isMetricEvent(event)
          ? liveMetric(event).pipe(Effect.map((events) => [state, events] as const))
          : Projection.step({ contract: ChatUi })(state, event),
    ),
  )

// CHATS: history and the last `seq` per chat id

class ChatNotFound extends Data.TaggedError("ChatNotFound")<{ readonly chatId: StreamId }> {}

type Chat = {
  readonly id: StreamId
  readonly history: Ref.Ref<History>
  readonly lastSeq: Ref.Ref<number>
  /** Calls waiting for the user's verdict. */
  readonly awaiting: Ref.Ref<ReadonlyArray<ToolCall>>
  /** Waiting calls that already have a placeholder output in `history`. */
  readonly held: Ref.Ref<HashSet.HashSet<string>>
}

const PLACEHOLDER = "Not run yet: waiting for the user's approval."

const makeChats = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom
  // The tools call the network; approved calls run while handling a request.
  const http = yield* Effect.context<HttpClient.HttpClient>()
  const chats = yield* Ref.make(HashMap.empty<StreamId, Chat>())

  const find = (chatId: StreamId) =>
    Ref.get(chats).pipe(
      Effect.flatMap((m) => Effect.fromOption(HashMap.get(m, chatId))),
      Effect.mapError(() => new ChatNotFound({ chatId })),
    )

  const create = Effect.gen(function* () {
    // UUIDv4: the chat id is all a caller needs, so keep it unguessable.
    const chat: Chat = {
      id: StreamId.make(yield* random.uuidV4()),
      history: yield* Ref.make<History>([]),
      lastSeq: yield* Ref.make(0),
      awaiting: yield* Ref.make<ReadonlyArray<ToolCall>>([]),
      held: yield* Ref.make(HashSet.empty<string>()),
    }
    yield* Ref.update(chats, HashMap.set(chat.id, chat))
    return chat
  })

  // A new message: apply `onFollowUp` to every waiting call. Every call needs an
  // output before the model's next turn, so a kept call gets a placeholder (once).
  const onMessage = (chat: Chat, input: Input.Submit) =>
    Effect.gen(function* () {
      const awaiting = yield* Ref.get(chat.awaiting)
      const held = yield* Ref.get(chat.held)
      const kept = awaiting.filter((call) => onFollowUp(call) === "keep")
      const superseded = yield* Effect.forEach(
        awaiting.filter((call) => onFollowUp(call) === "deny"),
        (call) => close(call, new Superseded({ message: "The user sent a new message instead." })),
      )
      const placeholders = kept
        .filter((call) => !HashSet.has(held, call.call_id))
        .map((call) => Items.toolCallOutput(call.call_id, PLACEHOLDER))
      const closings = yield* Effect.forEach(superseded, Toolkit.output(toolkit))
      yield* Ref.update(chat.history, (h) => [
        ...h,
        ...closings,
        ...placeholders,
        ...input.messages,
      ])
      yield* Ref.set(chat.awaiting, kept)
      yield* Ref.update(chat.held, (s) =>
        kept.reduce((acc, call) => HashSet.add(acc, call.call_id), s),
      )
      return superseded
    })

  // A verdict: only calls this chat is waiting for count; the client votes, the
  // server decides. Check here who may approve what.
  const onResolve = (chat: Chat, input: Input.Resolve) =>
    Effect.gen(function* () {
      const awaiting = yield* Ref.get(chat.awaiting)
      const held = yield* Ref.get(chat.held)
      // Groups only the calls this chat waits for; a stale answer is ignored.
      const { Approve, Deny, unanswered, invalid } = Approval.Default.resolve(
        awaiting,
        input.decisions,
      )
      const ran = yield* Toolkit.run(
        toolkit,
        Approve.map((a) => a.call),
      ).pipe(Stream.filter(Toolkit.isOutcome), Stream.runCollect, Effect.provideContext(http))
      // `Deny` carries the `Denied` it ends the call with.
      const denied = yield* Effect.forEach(Deny, ({ call, error }) => close(call, error))
      const results: ReadonlyArray<Toolkit.Outcome> = [...ran, ...denied]
      // A call with a placeholder already has its output; it learns the verdict from a note.
      const items = yield* Effect.forEach(results, (outcome) =>
        Effect.map(Toolkit.output(toolkit, outcome), (item) =>
          HashSet.has(held, outcome.call_id)
            ? Items.userText(
                `[${outcome.result._tag === "Success" ? "approved" : "not run"}] ${outcome.tool} (${outcome.call_id}): ${JSON.stringify(ToolOutput.value(item.output))}`,
              )
            : item,
        ),
      )
      yield* Ref.update(chat.history, (h) => [...h, ...items])
      // A call answered with something it doesn't take keeps waiting.
      yield* Ref.set(chat.awaiting, [...unanswered, ...invalid.map((i) => i.call)])
      return results
    })

  /** Answer `input` in the chat (a new one without `chatId`); the stream is the run. */
  const send = (chatId: Option.Option<StreamId>, input: Input.Input) =>
    Effect.gen(function* () {
      const chat = yield* Option.match(chatId, { onNone: () => create, onSome: find })
      const results =
        input.kind === "submit" ? yield* onMessage(chat, input) : yield* onResolve(chat, input)
      const history = yield* Ref.get(chat.history)
      const parked = yield* Ref.make<ReadonlyArray<ToolCall>>([])
      const runId = RunId.make(yield* random.uuidV7())
      // Calls still waiting without a placeholder have no output yet: the model can't be called.
      const held = yield* Ref.get(chat.held)
      const open = (yield* Ref.get(chat.awaiting)).filter((c) => !HashSet.has(held, c.call_id))
      // A verdict for nothing we wait for, or one that leaves calls open, doesn't call the model.
      const answer =
        input.kind === "resolve" && (results.length === 0 || open.length > 0)
          ? Stream.empty
          : agent(history, parked).pipe(
              Stream.tap((source) =>
                Effect.flatMap(historyOf(source), (items) =>
                  Ref.update(chat.history, (h) => [...h, ...items]),
                ),
              ),
              Metrics.allMetrics({
                throughput: { every: "500 millis", unit: "token", tokenizer: estimateTokens },
              }),
            )
      // Parked calls end the run as interrupted and wait in `chat.awaiting`; a partial
      // verdict ends it with the calls still open.
      const interrupt = Stream.unwrap(
        Ref.get(parked).pipe(
          Effect.tap((calls) => Ref.update(chat.awaiting, (a) => [...a, ...calls])),
          Effect.map((calls) => (input.kind === "resolve" && open.length > 0 ? open : calls)),
          Effect.map((calls) =>
            calls.length === 0 ? Stream.empty : Stream.make(interrupted(calls)),
          ),
        ),
      )
      // The settled calls' results go first, so their cards update.
      return Stream.fromIterable<Projection.Source>(results).pipe(
        Stream.concat(answer),
        toRunEvents,
        Run.coalesce("30 millis"),
        // The client gets the error's tag; the details stay in the server log.
        Stream.catchCause((cause) =>
          Stream.fromEffect(Effect.logError(cause).pipe(Effect.as(Run.failed(cause)))),
        ),
        Stream.concat(interrupt),
        Run.start({ runId, inputs: [input.id] }),
        Run.complete,
        Run.sequence(chat.id, { from: yield* Ref.get(chat.lastSeq) }),
        Stream.tap((envelope) => Ref.set(chat.lastSeq, envelope.seq)),
      )
    })

  return { send }
})

// ROUTE

// A message or a verdict (`Input.resolve`).
const ChatBody = Schema.Struct({ chatId: Schema.optionalKey(StreamId), input: Input.InputJson })

const ChatRoute = Layer.unwrap(
  Effect.gen(function* () {
    const chats = yield* makeChats
    // The run streams after the handler returns, so it carries its services along.
    const context = yield* Effect.context<LanguageModel | HttpClient.HttpClient>()
    return HttpRouter.add(
      "POST",
      "/api/chat",
      HttpServerRequest.schemaBodyJson(ChatBody).pipe(
        Effect.flatMap(({ chatId, input }) => chats.send(Option.fromNullishOr(chatId), input)),
        Effect.map((run) =>
          HttpServerResponse.stream(run.pipe(Stream.provideContext(context), SseEncoding.encode), {
            headers: SseEncoding.responseHeaders,
          }),
        ),
        Effect.catchTags({
          ChatNotFound: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
          SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
        }),
      ),
    )
  }),
)

const LanguageModelLive = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("OPENAI_API_KEY")
    return Responses.layer({ apiKey })
  }),
).pipe(Layer.provide(NodeHttpClient.layerUndici))

HttpRouter.serve(ChatRoute).pipe(
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 4321 })),
  Layer.provide(
    Layer.mergeAll(LanguageModelLive, NodeHttpClient.layerUndici, SecureRandom.layerWebCrypto),
  ),
  Layer.launch,
  NodeRuntime.runMain,
)
