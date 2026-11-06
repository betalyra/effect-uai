/**
 * The chat server: `POST /api/chat { chatId?, input }` answers with the run as
 * SSE. One request per message; the server keeps the history. The chat id is
 * the envelopes' `streamId`, so the page learns it from the first answer and
 * sends it back. Closing the response stops the run. In memory.
 */
import { createServer } from "node:http"
import type * as Items from "@effect-uai/core/Items"
import { type LanguageModel, streamTurn } from "@effect-uai/core/LanguageModel"
import * as SSE from "@effect-uai/core/SSE"
import { isTurnComplete } from "@effect-uai/core/Turn"
import * as Responses from "@effect-uai/responses/Responses"
import * as Encoding from "@effect-uai/ui/Encoding"
import * as Input from "@effect-uai/ui/Input"
import * as Projection from "@effect-uai/ui/Projection"
import * as Run from "@effect-uai/ui/Run"
import { RunId, StreamId } from "@effect-uai/ui/RunEvent"
import { NodeHttpClient, NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

const MODEL = "gpt-5.6-luna"

type Chat = {
  readonly history: Ref.Ref<ReadonlyArray<Items.HistoryItem>>
  /** The chat's last `seq`: the next run continues from it. */
  readonly lastSeq: Ref.Ref<number>
}

const ChatBody = Schema.Struct({ chatId: Schema.optionalKey(StreamId), input: Input.SubmitJson })

const chatRoute = Effect.gen(function* () {
  const chats = new Map<StreamId, Chat>()
  const random = yield* SecureRandom.SecureRandom
  const context = yield* Effect.context<LanguageModel>()

  const open = (chatId: StreamId | undefined) =>
    Effect.gen(function* () {
      if (chatId !== undefined) {
        return Option.map(
          Option.fromNullishOr(chats.get(chatId)),
          (chat) => [chatId, chat] as const,
        )
      }
      // UUIDv4: the chat id is all a caller needs, so keep it unguessable.
      const id = StreamId.make(yield* random.uuidV4())
      const chat: Chat = {
        history: yield* Ref.make<ReadonlyArray<Items.HistoryItem>>([]),
        lastSeq: yield* Ref.make(0),
      }
      chats.set(id, chat)
      return Option.some([id, chat] as const)
    })

  const answer = (id: StreamId, chat: Chat, input: Input.Submit) =>
    Effect.gen(function* () {
      // The question joins the history even if the run is stopped early.
      const history = yield* Ref.updateAndGet(chat.history, (h) => [
        ...h,
        ...Input.toHistory(input),
      ])
      const runId = RunId.make(yield* random.uuidV7())
      const from = yield* Ref.get(chat.lastSeq)
      return streamTurn({ history, model: MODEL }).pipe(
        Stream.tap((source) =>
          isTurnComplete(source)
            ? Ref.update(chat.history, (h) => [...h, ...source.turn.items])
            : Effect.void,
        ),
        Projection.toRunEvents(),
        Run.coalesce("30 millis"),
        Run.withTerminal({ runId, inputs: [input.id] }),
        Run.sequence(id, { from }),
        Stream.tap((envelope) => Ref.set(chat.lastSeq, envelope.seq)),
        Stream.provideContext(context),
      )
    })

  return HttpRouter.add(
    "POST",
    "/api/chat",
    Effect.gen(function* () {
      const { chatId, input } = yield* HttpServerRequest.schemaBodyJson(ChatBody)
      const found = yield* open(chatId)
      if (Option.isNone(found)) return HttpServerResponse.empty({ status: 404 })
      const run = yield* answer(...found.value, input)
      return HttpServerResponse.stream(run.pipe(Encoding.toSSE, SSE.toBytes), {
        headers: Encoding.responseHeaders,
      })
    }),
  )
})

const LanguageModelLive = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("OPENAI_API_KEY")
    return Responses.layer({ apiKey })
  }),
).pipe(Layer.provide(NodeHttpClient.layerUndici))

HttpRouter.serve(Layer.unwrap(chatRoute)).pipe(
  Layer.provide(NodeHttpServer.layer(() => createServer(), { port: 3001 })),
  Layer.provide(Layer.mergeAll(LanguageModelLive, SecureRandom.layerWebCrypto)),
  Layer.launch,
  NodeRuntime.runMain,
)
