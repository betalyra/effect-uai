/**
 * The main page's chat state: `Atoms.thread` over a direct transport, typed
 * by the shared `ChatUi` contract (envelopes are decoded on arrival). The
 * thread keeps the chat id the server named on its first answer and sends it
 * back. Stop aborts the request.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Input from "@effect-uai/ui/Input"
import { StreamId } from "@effect-uai/ui/RunEvent"
import type * as Thread from "@effect-uai/ui/Thread"
import * as Transport from "@effect-uai/ui/Transport"
import { Layer, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { FetchHttpClient, HttpClientRequest } from "effect/http"
import { Atom } from "effect/reactivity"
import { type ChatPayloads, ChatUi } from "./chat-ui"

// A message (`Input.submit`) or a verdict on a waiting call (`Input.resolve`).
const ChatBody = Schema.Struct({ chatId: Schema.optionalKey(StreamId), input: Input.InputJson })

const transport = Transport.direct({
  request: (input: Input.Sent<Input.Input>, thread: Thread.Thread<ChatPayloads>) =>
    HttpClientRequest.post("/api/ui/chat").pipe(
      HttpClientRequest.schemaBodyJson(ChatBody)(
        thread.streamId === null ? { input } : { chatId: thread.streamId, input },
      ),
    ),
})

export const chat = Atoms.thread({
  contract: ChatUi,
  runtime: Atom.runtime(Layer.mergeAll(FetchHttpClient.layer, SecureRandom.layerWebCrypto)),
  transport,
  busy: "block",
})
