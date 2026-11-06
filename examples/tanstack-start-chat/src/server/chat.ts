/**
 * The chat server: `POST /api/chat { chatId?, input }` answers with the run as
 * SSE. One request per message; the server keeps the history. The chat id is
 * the envelopes' `streamId`, so the page learns it from the first answer and
 * sends it back. In memory.
 *
 * The route is a plain Effect `HttpRouter` route; `HttpRouter.toWebHandler`
 * turns it into the `(Request) => Promise<Response>` TanStack's server route
 * calls. A closed request interrupts the run.
 */
import type * as Items from "@effect-uai/core/Items"
import { type LanguageModel, streamTurn } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import * as ToolEvent from "@effect-uai/core/ToolEvent"
import { toToolCallOutput } from "@effect-uai/core/ToolResult"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import * as Responses from "@effect-uai/responses/Responses"
import * as Input from "@effect-uai/ui/Input"
import * as Projection from "@effect-uai/ui/Projection"
import * as Run from "@effect-uai/ui/Run"
import { RunId, StreamId } from "@effect-uai/ui/RunEvent"
import * as SseEncoding from "@effect-uai/ui/SseEncoding"
import { Config, Data, DateTime, Effect, HashMap, Layer, Option, Ref, Schema, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import { GetDate, GetWeather } from "../chat-ui"

const MODEL = "gpt-5.6-luna"

// TOOLS: the shared specs plus a `run`

// An unknown timezone fails the call; the model sees the error and can retry.
const getDate = Tool.make({
  ...GetDate,
  run: ({ timezone }) =>
    Option.match(DateTime.zoneMakeNamed(timezone), {
      onNone: () => Effect.fail(`Unknown IANA timezone: ${timezone}`),
      onSome: () =>
        DateTime.now.pipe(Effect.map((now) => ({ timezone, now: DateTime.toDate(now) }))),
    }),
})

const skies = ["sunny", "cloudy", "rainy"] as const

// A stub with stable answers per city; a real app calls a weather API here.
const getWeather = Tool.make({
  ...GetWeather,
  run: ({ city }) =>
    DateTime.now.pipe(
      Effect.map((now) => {
        const seed = [...city].reduce((n, c) => n + c.charCodeAt(0), 0)
        return {
          city,
          temperatureC: 8 + (seed % 20),
          sky: skies[seed % skies.length] ?? "sunny",
          observedAt: DateTime.toDate(now),
        }
      }),
    ),
})

const toolkit = Toolkit.make(getDate, getWeather)

// AGENT: model turns until it stops calling tools

type History = ReadonlyArray<Items.HistoryItem>

const agent = (history: History) =>
  loop(({ history }: { readonly history: History }) =>
    streamTurn({ history, model: MODEL, tools: toolkit }).pipe(
      onTurnComplete((turn) =>
        Effect.sync(() => {
          const calls = Turn.getToolCalls(turn)
          return calls.length === 0
            ? stop()
            : Toolkit.run(toolkit, calls).pipe(
                Toolkit.continueWithResults(Toolkit.appendToolResults({ history }, turn)),
              )
        }),
      ),
    ),
  )({ history })

// What one loop event adds to the chat's history: the turn's items, a tool's output.
const historyOf = (source: Projection.Source): History => {
  if (Turn.isTurnComplete(source)) return source.turn.items
  if (ToolEvent.isOutput(source)) return [toToolCallOutput(source.result)]
  return []
}

// CHATS: history and the last `seq` per chat id

class ChatNotFound extends Data.TaggedError("ChatNotFound")<{ readonly chatId: StreamId }> {}

type Chat = {
  readonly id: StreamId
  readonly history: Ref.Ref<History>
  readonly lastSeq: Ref.Ref<number>
}

const makeChats = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom
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
    }
    yield* Ref.update(chats, HashMap.set(chat.id, chat))
    return chat
  })

  /** Answer `input` in the chat (a new one without `chatId`); the stream is the run. */
  const send = (chatId: Option.Option<StreamId>, input: Input.Submit) =>
    Effect.gen(function* () {
      const chat = yield* Option.match(chatId, { onNone: () => create, onSome: find })
      const history = yield* Ref.updateAndGet(chat.history, (h) => [...h, ...input.messages])
      const runId = RunId.make(yield* random.uuidV7())
      return agent(history).pipe(
        Stream.tap((source) => Ref.update(chat.history, (h) => [...h, ...historyOf(source)])),
        Projection.toRunEvents(),
        Run.coalesce("30 millis"),
        // The client gets the error's tag; the details stay in the server log.
        Stream.catchCause((cause) =>
          Stream.fromEffect(Effect.logError(cause).pipe(Effect.as(Run.failed(cause)))),
        ),
        Run.start({ runId, inputs: [input.id] }),
        Run.complete,
        Run.sequence(chat.id, { from: yield* Ref.get(chat.lastSeq) }),
        Stream.tap((envelope) => Ref.set(chat.lastSeq, envelope.seq)),
      )
    })

  return { send }
})

// ROUTE

const ChatBody = Schema.Struct({ chatId: Schema.optionalKey(StreamId), input: Input.SubmitJson })

const ChatRoute = Layer.unwrap(
  Effect.gen(function* () {
    const chats = yield* makeChats
    const context = yield* Effect.context<LanguageModel>()
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
).pipe(Layer.provide(FetchHttpClient.layer))

// Built once per server process; TanStack's route hands it each request.
export const { handler } = HttpRouter.toWebHandler(
  ChatRoute.pipe(
    Layer.provide(Layer.mergeAll(LanguageModelLive, SecureRandom.layerWebCrypto)),
    Layer.provide(HttpServer.layerServices),
  ),
)
