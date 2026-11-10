/**
 * Composition for the durable-chat recipe: the page plus three routes over
 * `makeChats`. A chat id is a stream id: one stream carries every run.
 *
 *   GET  /                                           → the chat page (client/main.ts)
 *   POST /chats/messages         { chatId?, input }  → 202 { chatId } (queued; no chatId: a new chat)
 *   GET  /chats/:id/events       SSE                 → the whole chat, replay then live
 *   POST /chats/:id/stop                             → 202, `run-stopped` arrives on the stream
 */
import { streamTurn } from "@effect-uai/core/LanguageModel"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import * as Input from "@effect-uai/ui/Input"
import { StreamId } from "@effect-uai/ui/RunEvent"
import * as SseEncoding from "@effect-uai/ui/SseEncoding"
import { Effect, FileSystem, Layer, Option, Path, Schema, Stdio } from "effect"
import { SecureRandom } from "effect/crypto"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { makeChats } from "./recipe.js"

const DEFAULT_MODEL = "gpt-5.6-luna"

const SendBody = Schema.Struct({ chatId: Schema.optionalKey(StreamId), input: Input.SubmitJson })
const EventParams = Schema.Struct({
  id: StreamId,
  // This app's own position for a fresh connection; a reconnect's
  // `Last-Event-ID` header wins because EventSource reuses the original URL.
  after: Schema.optionalKey(Schema.FiniteFromString.check(Schema.isInt())),
})
const StopParams = Schema.Struct({ id: StreamId })

const server = (model: string, page: { readonly html: string; readonly js: string }) =>
  Effect.gen(function* () {
    const chats = yield* makeChats((history) => streamTurn({ history, model }))

    const send = HttpServerRequest.schemaBodyJson(SendBody).pipe(
      Effect.flatMap(({ chatId, input }) => chats.send(Option.fromNullishOr(chatId), input)),
      Effect.flatMap((chatId) => HttpServerResponse.json({ chatId }, { status: 202 })),
      Effect.catchTag("ChatNotFound", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
    )

    const events = Effect.gen(function* () {
      const { id, after } = yield* HttpRouter.schemaParams(EventParams)
      const request = yield* HttpServerRequest.HttpServerRequest
      const from = SseEncoding.lastEventId(request.headers).pipe(Option.getOrElse(() => after ?? 0))
      const stream = yield* chats.events(id, from)
      // A comment every 15 s keeps proxies from closing a chat that sits idle.
      const body = stream.pipe(SseEncoding.encode, SseEncoding.heartbeat("15 seconds"))
      return HttpServerResponse.stream(body, {
        headers: { ...SseEncoding.responseHeaders, "x-accel-buffering": "no" },
      })
    }).pipe(
      Effect.catchTag("ChatNotFound", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
    )

    const stop = HttpRouter.schemaParams(StopParams).pipe(
      Effect.flatMap(({ id }) => chats.stop(id)),
      Effect.as(HttpServerResponse.empty({ status: 202 })),
      Effect.catchTag("ChatNotFound", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
    )

    yield* Effect.logInfo("durable-chat on http://localhost:3000")
    return yield* Layer.launch(
      HttpRouter.serve(
        Layer.mergeAll(
          HttpRouter.add("GET", "/", HttpServerResponse.html(page.html)),
          HttpRouter.add(
            "GET",
            "/client.js",
            HttpServerResponse.text(page.js, {
              contentType: "application/javascript; charset=utf-8",
            }),
          ),
          HttpRouter.add("POST", "/chats/messages", send),
          HttpRouter.add("GET", "/chats/:id/events", events),
          HttpRouter.add("POST", "/chats/:id/stop", stop),
        ),
      ),
    )
  }).pipe(Effect.scoped)

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", yield* stdio.args), () => DEFAULT_MODEL),
    "openai",
  )
  const recipeDir = path.dirname(new URL(import.meta.url).pathname)
  const page = {
    html: yield* fs.readFileString(path.join(recipeDir, "client/index.html")),
    js: yield* bundleClient(path.join(recipeDir, "client/main.ts")),
  }
  // @effect-diagnostics-next-line returnEffectInGen:off
  return server(spec.model, page).pipe(
    Effect.provide(Layer.merge(languageModelLayer(spec), SecureRandom.layerWebCrypto)),
  )
}).pipe(Effect.flatten)
