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
import { type Envelope, StreamId } from "@effect-uai/ui/RunEvent"
import * as RunView from "@effect-uai/ui/RunView"
import * as Thread from "@effect-uai/ui/Thread"
import * as Transport from "@effect-uai/ui/Transport"
import { Effect, Option, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpIncomingMessage } from "effect/http"
import { Atom, AtomRegistry } from "effect/reactivity"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

const STORAGE_KEY = "durable-chat:chat"

// ---------------------------------------------------------------------------
// Transport: the routes of app.ts
// ---------------------------------------------------------------------------

const SendBody = Schema.Struct({ chatId: Schema.optionalKey(StreamId), input: Input.SubmitJson })
const Sent = Schema.Struct({ chatId: StreamId })

const transport = Transport.session({
  send: (chatId, input: Input.Sent<Input.Submit>) =>
    HttpClientRequest.post("/chats/messages").pipe(
      HttpClientRequest.schemaBodyJson(SendBody)(
        Option.match(chatId, {
          onNone: () => ({ input }),
          onSome: (id) => ({ chatId: id, input }),
        }),
      ),
      Effect.flatMap(HttpClient.execute),
      Effect.flatMap(HttpIncomingMessage.schemaBodyJson(Sent)),
      Effect.map(({ chatId }) => ({ streamId: chatId })),
    ),
  // The whole chat; reconnects from the last seen `seq` when the connection drops.
  events: (chatId, after) =>
    Client.resumable(
      (from) => Client.sse(HttpClientRequest.get(`/chats/${chatId}/events?after=${from}`)),
      { from: after, until: "never", schedule: Schedule.spaced("1 second") },
    ),
  stop: (chatId) => HttpClient.post(`/chats/${chatId}/stop`).pipe(Effect.asVoid),
})

// ---------------------------------------------------------------------------
// State: the Thread fold, plus the server's echo of each input. After a
// reload the page has lost what the user typed; each run carries it.
// ---------------------------------------------------------------------------

const decodeInput = Schema.decodeUnknownOption(Input.SubmitJson)

const step = (thread: Thread.Thread, envelope: Envelope): Thread.Thread => {
  const next = Thread.step(thread, envelope)
  const event = envelope.event
  if (event.type !== "data" || event.name !== "input") return next
  return Option.match(decodeInput(event.value), {
    onNone: () => next,
    // Echoed when queued: it waits in `pending` until its run starts.
    onSome: (input) =>
      Thread.hasInput(next, input.id)
        ? next
        : {
            ...next,
            pending: [...next.pending, { role: "user", id: input.id, messages: input.messages }],
          },
  })
}

const chat = Atoms.chat({ runtime: Atom.runtime(FetchHttpClient.layer), transport, step })

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

const live = (run: RunView.RunView) => {
  const text = RunView.text(run)
  return text === "" ? bubble("assistant", "…", "thinking") : bubble("assistant", text, "streaming")
}

const render = (thread: Thread.Thread) => {
  const settled = thread.messages.map((m) =>
    m.role === "user"
      ? bubble("user", Input.text(m))
      : bubble("assistant", RunView.text(m.run), note(m.run)),
  )
  const active = thread.active === null ? [] : [live(thread.active)]
  // Sent while a run was going: the server runs them next, in order.
  const pending = thread.pending.map((m) => bubble("user", Input.text(m), "queued"))
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
