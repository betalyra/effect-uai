/**
 * Browser entry point, bundled at server startup and served as `/client.js`.
 *
 * One live session over `@effect-uai/ui`. The server opens the mic channel
 * at the rate its transcriber takes; the page records with `Media.mic` and
 * sends each frame on it. Each reply is a run that opens its own audio
 * channel; the audio plays through one `Media.pcmPlayer`, and a reply the
 * user cuts short with a stop word (`run-stopped`) drops what is still queued.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Frame from "@effect-uai/ui/Frame"
import * as Media from "@effect-uai/ui/Media"
import * as RunView from "@effect-uai/ui/RunView"
import * as StreamView from "@effect-uai/ui/StreamView"
import * as Transport from "@effect-uai/ui/Transport"
import type * as UiContract from "@effect-uai/ui/UiContract"
import { Effect, Exit, Fiber, Scope, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import * as Socket from "effect/socket/Socket"
import { MIC, SPEAKER, Up, VoiceUi } from "../contract.js"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

type Payloads = UiContract.Payloads<typeof VoiceUi>
type View = StreamView.StreamView<Payloads>

// ---------------------------------------------------------------------------
// Playback: one player per session, at the rate the first reply declares
// ---------------------------------------------------------------------------

let player: { readonly scope: Scope.Closeable; readonly ready: Promise<Media.Player> } | null = null

const openPlayer = (sampleRate: number): void => {
  const scope = Effect.runSync(Scope.make())
  const ready = Effect.runPromise(
    Media.pcmPlayer({ sampleRate, worklet: Media.playerWorklet }).pipe(Scope.provide(scope)),
  )
  ready.catch((error: Media.MediaError) =>
    setStatus(`audio ${error.reason}: ${error.message}`, true),
  )
  player = { scope, ready }
}

const withPlayer = (f: (p: Media.Player) => Effect.Effect<void>) => {
  const current = player
  return current === null
    ? Effect.void
    : Effect.promise(() => current.ready).pipe(Effect.flatMap(f))
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`

const session = Atoms.live({
  runtime: Atom.runtime(Socket.layerWebSocketConstructorGlobal),
  transport: Transport.live({ connect: Transport.socket(wsUrl), up: Up }),
  initial: StreamView.empty<Payloads>(),
  step: StreamView.step,
  decode: VoiceUi.decode,
  media: (frame) =>
    frame.channel === SPEAKER ? withPlayer((p) => p.push(frame.bytes)) : Effect.void,
})

const registry = AtomRegistry.make()

// ---------------------------------------------------------------------------
// Mic: a fiber that sends `Media.mic` frames on the channel the session opened
// ---------------------------------------------------------------------------

let mic: Fiber.Fiber<void> | null = null

const startMic = (sampleRate: number) =>
  Media.mic({ sampleRate, worklet: Media.micWorklet }).pipe(
    Stream.runForEach((bytes) =>
      Effect.sync(() => registry.set(session.send, Frame.media(MIC, bytes))),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        setStatus(`mic ${error.reason}: ${error.message}`, true)
        registry.set(session.disconnect, undefined)
      }),
    ),
    Effect.runFork,
  )

const stopDevices = (): void => {
  if (mic !== null) Effect.runFork(Fiber.interrupt(mic))
  mic = null
  if (player !== null) Effect.runFork(Scope.close(player.scope, Exit.void))
  player = null
}

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`#${id} missing`)
  return el as T
}

const toggleBtn = $<HTMLButtonElement>("toggle")
const statusEl = $("status")
const conversationEl = $("conversation")

const setStatus = (text: string, error = false): void => {
  statusEl.textContent = text
  statusEl.classList.toggle("err", error)
}

const block = (role: "user" | "assistant", text: string, partial: boolean): HTMLElement => {
  const el = document.createElement("div")
  el.className = `transcript ${role}`
  const label = document.createElement("div")
  label.className = "role"
  label.textContent = role
  const body = document.createElement("span")
  body.textContent = text
  body.classList.toggle("partial", partial)
  el.append(label, body)
  return el
}

const promptOf = (reply: RunView.RunView<Payloads>): string =>
  reply.blocks.flatMap((b) => (b.type === "data" && b.name === "prompt" ? [b.value] : [])).join(" ")

/** Each reply with the words that started it, then whatever the user is saying now. */
const render = (view: View): void => {
  const replies = StreamView.runsOf(view, "assistant")
  const utterances = Object.entries(view.data.transcript ?? {}).sort(
    ([a], [b]) => Number(a) - Number(b),
  )
  const speaking = utterances.at(-1)?.[1]
  conversationEl.replaceChildren(
    ...replies.flatMap((reply) => [
      block("user", promptOf(reply), false),
      block("assistant", RunView.text(reply), reply.status === "streaming"),
    ]),
    ...(speaking !== undefined && !speaking.final ? [block("user", speaking.text, true)] : []),
  )
  const problem = view.live.problem
  if (problem !== undefined) setStatus(problem, true)
  else setStatus(replies.at(-1)?.status === "streaming" ? "speaking…" : "listening")
}

// Replies already cleared from the player after a stop word.
const cleared = new Set<string>()

registry.subscribe(
  session.state,
  (view) => {
    render(view)
    const up = view.channels[MIC]
    if (mic === null && up !== undefined) mic = startMic(up.sampleRate ?? 16000)
    const down = view.channels[SPEAKER]
    if (player === null && down !== undefined) openPlayer(down.sampleRate ?? 48000)
    // A stop word ends the reply early: drop what is still queued, so it stops at once.
    for (const reply of StreamView.runsOf(view, "assistant")) {
      if (reply.status !== "stopped" || reply.runId === undefined || cleared.has(reply.runId))
        continue
      cleared.add(reply.runId)
      Effect.runFork(withPlayer((p) => p.clear))
    }
  },
  { immediate: true },
)

registry.subscribe(
  session.connected,
  (connected) => {
    toggleBtn.textContent = connected ? "Stop" : "Start"
    if (!connected) stopDevices()
  },
  { immediate: true },
)

toggleBtn.addEventListener("click", () => {
  if (registry.get(session.connected)) {
    setStatus("stopped")
    registry.set(session.disconnect, undefined)
  } else {
    setStatus("connecting…")
    cleared.clear()
    registry.set(session.connect, undefined)
  }
})
