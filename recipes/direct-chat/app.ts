/**
 * Composition for the direct-chat recipe: the page plus one route over
 * `makeChats`. The response body is the run; closing it stops the run.
 *
 *   GET  /                               → the chat page (client/main.ts)
 *   GET  /client.js                      → the page's script
 *   POST /chat   { chatId?, input }      → SSE: the run (no chatId: a new chat)
 */
import { type LanguageModel, streamTurn } from "@effect-uai/core/LanguageModel"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { bundleClient } from "@effect-uai/recipe-kit/bundle"
import * as Input from "@effect-uai/ui/Input"
import { StreamId } from "@effect-uai/ui/RunEvent"
import * as SseEncoding from "@effect-uai/ui/SseEncoding"
import { Effect, FileSystem, Layer, Option, Path, Schema, Stdio, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { makeChats } from "./recipe.js"

const DEFAULT_MODEL = "gpt-5.6-luna"

const ChatBody = Schema.Struct({ chatId: Schema.optionalKey(StreamId), input: Input.SubmitJson })

const server = (model: string, page: { readonly html: string; readonly js: string }) =>
  Effect.gen(function* () {
    const chats = yield* makeChats((history) => streamTurn({ history, model }))
    const context = yield* Effect.context<LanguageModel>()

    const chat = HttpServerRequest.schemaBodyJson(ChatBody).pipe(
      Effect.flatMap(({ chatId, input }) => chats.send(Option.fromNullishOr(chatId), input)),
      Effect.map((run) =>
        HttpServerResponse.stream(run.pipe(Stream.provideContext(context), SseEncoding.encode), {
          headers: { ...SseEncoding.responseHeaders, "x-accel-buffering": "no" },
        }),
      ),
      Effect.catchTag("ChatNotFound", () =>
        Effect.succeed(HttpServerResponse.empty({ status: 404 })),
      ),
    )

    yield* Effect.logInfo("direct-chat on http://localhost:3000")
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
          HttpRouter.add("POST", "/chat", chat),
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
