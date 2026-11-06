/**
 * The chat server: one request per message, the response streams the run,
 * the server keeps the history. The chat id is the envelopes' `streamId`, so
 * the page learns it from the first answer and sends it back with the next.
 * In memory; a real app persists history.
 */
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
import { Config, Effect, Layer, ManagedRuntime, Option, Ref, Schema, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { FetchHttpClient } from "effect/http"

const MODEL = "gpt-5.6-luna"

type Chat = {
  readonly history: Ref.Ref<ReadonlyArray<Items.HistoryItem>>
  /** The chat's last `seq`: the next run continues from it. */
  readonly lastSeq: Ref.Ref<number>
}

const chats = new Map<StreamId, Chat>()

const open = (chatId: StreamId | undefined) =>
  Effect.gen(function* () {
    if (chatId !== undefined) {
      return Option.map(Option.fromNullishOr(chats.get(chatId)), (chat) => [chatId, chat] as const)
    }
    const random = yield* SecureRandom.SecureRandom
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
    const random = yield* SecureRandom.SecureRandom
    // The question joins the history even if the run is stopped early.
    const history = yield* Ref.updateAndGet(chat.history, (h) => [...h, ...Input.toHistory(input)])
    const runId = RunId.make(yield* random.uuidV7())
    const from = yield* Ref.get(chat.lastSeq)
    const context = yield* Effect.context<LanguageModel>()
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

// Completes when the browser goes away (Stop aborts the fetch), so the run is interrupted.
const aborted = (signal: AbortSignal) =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) return resume(Effect.void)
    const onAbort = () => resume(Effect.void)
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    Layer.unwrap(
      Effect.gen(function* () {
        const apiKey = yield* Config.Redacted("OPENAI_API_KEY")
        return Responses.layer({ apiKey })
      }),
    ).pipe(Layer.provide(FetchHttpClient.layer)),
    SecureRandom.layerWebCrypto,
  ),
)

const ChatBody = Schema.Struct({ chatId: Schema.optionalKey(StreamId), input: Input.SubmitJson })

/** `POST /api/chat { chatId?, input }`: the run as SSE; 404 for an unknown chat. */
export const handle = (request: Request): Promise<Response> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const json = yield* Effect.tryPromise(() => request.json())
      const { chatId, input } = yield* Schema.decodeUnknownEffect(ChatBody)(json)
      const found = yield* open(chatId)
      if (Option.isNone(found)) return new Response(null, { status: 404 })
      const run = yield* answer(...found.value, input)
      const body = run.pipe(
        Stream.interruptWhen(aborted(request.signal)),
        Encoding.toSSE,
        SSE.toBytes,
        Stream.toReadableStream(),
      )
      return new Response(body, { headers: Encoding.responseHeaders })
    }).pipe(
      Effect.catchTags({
        UnknownError: () => Effect.succeed(new Response(null, { status: 400 })),
        SchemaError: () => Effect.succeed(new Response(null, { status: 400 })),
      }),
    ),
  )
