/**
 * durable-chat browser client: plain DOM over `@effect-uai/ui`.
 *
 * One chat is one session stream that carries every run. The page keeps the
 * chat id in `localStorage`; on load it re-opens the chat and the server
 * replays it from the start, so a reload brings back every message and picks
 * up an answer that is still streaming.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Client from "@effect-uai/ui/Client"
import * as Input from "@effect-uai/ui/Input"
import { StreamId } from "@effect-uai/ui/RunEvent"
import * as RunView from "@effect-uai/ui/RunView"
import type * as Thread from "@effect-uai/ui/Thread"
import * as Transport from "@effect-uai/ui/Transport"
import { Effect, Layer, Option, Schedule, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { FetchHttpClient, HttpClientRequest, HttpIncomingMessage } from "effect/http"
import { Atom, AtomRegistry } from "effect/reactivity"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

const STORAGE_KEY = "durable-chat:chat"

// ---------------------------------------------------------------------------
// The chat: the routes of app.ts as a session transport, state as a Thread
// ---------------------------------------------------------------------------

const SendBody = Schema.Struct({ chatId: Schema.optionalKey(StreamId), input: Input.SubmitJson })
const SendResponse = Schema.Struct({ chatId: StreamId })

const transport = Transport.sessionHttp({
  // No chat id: the server starts a chat and answers `{ chatId }`.
  send: (chatId, input: Input.Sent<Input.Submit>) =>
    HttpClientRequest.post("/chats/messages").pipe(
      HttpClientRequest.schemaBodyJson(SendBody)(
        Option.match(chatId, {
          onNone: () => ({ input }),
          onSome: (id) => ({ chatId: id, input }),
        }),
      ),
      Effect.flatMap(Client.execute),
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(SendResponse)),
      Effect.map((response) => response.chatId),
    ),
  events: (chatId, after) => HttpClientRequest.get(`/chats/${chatId}/events?after=${after}`),
  stop: (chatId) => HttpClientRequest.post(`/chats/${chatId}/stop`),
  // The chat's stream never ends on its own: keep reconnecting.
  reconnect: Schedule.spaced("1 second"),
})

const chat = Atoms.sessionThread({
  runtime: Atom.runtime(Layer.mergeAll(FetchHttpClient.layer, SecureRandom.layerWebCrypto)),
  transport,
})

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const log = $<HTMLDivElement>("log")
const form = $<HTMLFormElement>("form")
const prompt = $<HTMLInputElement>("prompt")
const stopButton = $<HTMLButtonElement>("stop")
const clear = $<HTMLButtonElement>("clear")

const bubble = (role: "user" | "assistant", text: string, note?: string) => {
  const el = document.createElement("div")
  el.className = role
  el.textContent = text
  if (note !== undefined) {
    const small = document.createElement("small")
    small.textContent = note
    el.append(small)
  }
  return el
}

const note = (run: RunView.RunView): string | undefined => {
  if (run.status === "stopped") return "stopped"
  if (run.status === "failed") return `failed: ${run.error?.reason}`
  return undefined
}

// The answer, or the refusal when the model declined.
const answer = (run: RunView.RunView) => RunView.text(run) || (RunView.refusal(run) ?? "")

const live = (run: RunView.RunView) => {
  const text = answer(run)
  return text === "" ? bubble("assistant", "…", "thinking") : bubble("assistant", text, "streaming")
}

const render = (thread: Thread.Thread) => {
  const settled = thread.messages.map((m) =>
    m.role === "user"
      ? bubble("user", Input.text(m.value))
      : bubble("assistant", answer(m.value), note(m.value)),
  )
  const active = thread.active === null ? [] : [live(thread.active)]
  // Waiting for their run: the server answers them next, together.
  const pending = thread.pending.map((m) => bubble("user", Input.text(m.value), "queued"))
  log.replaceChildren(...settled, ...active, ...pending)
  log.scrollTop = log.scrollHeight
  stopButton.disabled = thread.active === null
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const registry = AtomRegistry.make()
registry.subscribe(chat.state, render, { immediate: true })
registry.subscribe(chat.streamId, (id) => {
  if (id !== null) localStorage.setItem(STORAGE_KEY, id)
})

form.addEventListener("submit", (e) => {
  e.preventDefault()
  const text = prompt.value.trim()
  if (text === "") return
  registry.set(chat.submit, Input.submit(text))
  prompt.value = ""
})
stopButton.addEventListener("click", () => registry.set(chat.stop, undefined))
clear.addEventListener("click", () => {
  localStorage.removeItem(STORAGE_KEY)
  location.reload()
})

// Re-open the stored chat: the server replays it from the start.
Option.fromNullishOr(localStorage.getItem(STORAGE_KEY)).pipe(
  Option.flatMap(Schema.decodeUnknownOption(StreamId)),
  Option.map((chatId) => registry.set(chat.open, chatId)),
)
