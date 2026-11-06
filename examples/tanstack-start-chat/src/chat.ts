/**
 * The page's chat state: `Atoms.thread` over a direct transport. Each message
 * is one request; the thread keeps the chat id the server named on its first
 * answer and sends it back. Stop aborts the request.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Input from "@effect-uai/ui/Input"
import { StreamId } from "@effect-uai/ui/RunEvent"
import type * as Thread from "@effect-uai/ui/Thread"
import * as Transport from "@effect-uai/ui/Transport"
import { Schema } from "effect"
import { FetchHttpClient, HttpClientRequest } from "effect/http"
import { Atom } from "effect/reactivity"

const ChatBody = Schema.Struct({ chatId: Schema.optionalKey(StreamId), input: Input.SubmitJson })

const transport = Transport.direct({
  request: (input: Input.Sent<Input.Submit>, thread: Thread.Thread) =>
    HttpClientRequest.post("/api/chat").pipe(
      HttpClientRequest.schemaBodyJson(ChatBody)(
        thread.streamId === null ? { input } : { chatId: thread.streamId, input },
      ),
    ),
})

export const chat = Atoms.thread({
  runtime: Atom.runtime(FetchHttpClient.layer),
  transport,
  busy: "block",
})
