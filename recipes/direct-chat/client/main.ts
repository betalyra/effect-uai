/**
 * direct-chat browser client: plain DOM over `@effect-uai/ui`.
 *
 * Each message is one request; its response is the run. The server owns the
 * history and names the chat on its first answer (the envelopes'
 * `streamId`), which the thread keeps and every later request sends back.
 * Stop aborts the request. A reload starts a new chat.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Input from "@effect-uai/ui/Input"
import { StreamId } from "@effect-uai/ui/RunEvent"
import * as RunView from "@effect-uai/ui/RunView"
import type * as Thread from "@effect-uai/ui/Thread"
import * as Transport from "@effect-uai/ui/Transport"
import { Schema } from "effect"
import { FetchHttpClient, HttpClientRequest } from "effect/http"
import { Atom, AtomRegistry } from "effect/reactivity"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

// ---------------------------------------------------------------------------
// The chat: one request per message, state as a Thread
// ---------------------------------------------------------------------------

const ChatBody = Schema.Struct({ chatId: Schema.optionalKey(StreamId), input: Input.SubmitJson })

const transport = Transport.direct({
  // No chat id yet: the server starts one.
  request: (input: Input.Sent<Input.Submit>, thread: Thread.Thread) =>
    HttpClientRequest.post("/chat").pipe(
      HttpClientRequest.schemaBodyJson(ChatBody)(
        thread.streamId === null ? { input } : { chatId: thread.streamId, input },
      ),
    ),
})

const chat = Atoms.thread({
  runtime: Atom.runtime(FetchHttpClient.layer),
  transport,
  busy: "block",
})

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const log = $<HTMLDivElement>("log")
const form = $<HTMLFormElement>("form")
const prompt = $<HTMLInputElement>("prompt")
const send = $<HTMLButtonElement>("send")
const stopButton = $<HTMLButtonElement>("stop")

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
  log.replaceChildren(...settled, ...active)
  log.scrollTop = log.scrollHeight
  // One run at a time: the next message waits for this answer.
  send.disabled = thread.active !== null
  stopButton.disabled = thread.active === null
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const registry = AtomRegistry.make()
registry.subscribe(chat.state, render, { immediate: true })

form.addEventListener("submit", (e) => {
  e.preventDefault()
  const text = prompt.value.trim()
  if (text === "") return
  registry.set(chat.submit, Input.submit(text))
  prompt.value = ""
})
stopButton.addEventListener("click", () => registry.set(chat.stop, undefined))
