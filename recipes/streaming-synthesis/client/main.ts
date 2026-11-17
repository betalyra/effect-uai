/**
 * Browser entry point: one live session over `@effect-uai/ui`, opened on
 * the first Enter and held across lines. Each line goes up as a message;
 * the server declares the speech format with `channel-opened`, and the
 * speech arrives as media frames on that channel, played gap-free by a
 * `Media.pcmPlayer` at that format's rate.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Frame from "@effect-uai/ui/Frame"
import * as Media from "@effect-uai/ui/Media"
import * as StreamView from "@effect-uai/ui/StreamView"
import * as Transport from "@effect-uai/ui/Transport"
import type * as UiContract from "@effect-uai/ui/UiContract"
import { Effect, Exit, Scope } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import * as Socket from "effect/socket/Socket"
import { Say, SPEAKER, SynthesisUi } from "../contract.js"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

type View = StreamView.StreamView<UiContract.Payloads<typeof SynthesisUi>>

// ---------------------------------------------------------------------------
// Playback: created when the session declares the speech format
// ---------------------------------------------------------------------------

// One player per session, in its own scope; frames that arrive while it starts wait for it.
let player: { readonly scope: Scope.Closeable; readonly ready: Promise<Media.Player> } | null = null

const openPlayer = (sampleRate: number): void => {
  const scope = Effect.runSync(Scope.make())
  const ready = Effect.runPromise(Media.pcmPlayer({ sampleRate }).pipe(Scope.provide(scope)))
  ready.catch((error: Media.MediaError) =>
    setStatus(`audio ${error.reason}: ${error.message}`, true),
  )
  player = { scope, ready }
}

const closePlayer = (): void => {
  if (player !== null) Effect.runFork(Scope.close(player.scope, Exit.void))
  player = null
}

const play = (bytes: Uint8Array) => {
  const current = player
  return current === null
    ? Effect.void
    : Effect.promise(() => current.ready).pipe(Effect.flatMap((p) => p.push(bytes)))
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`

const session = Atoms.live({
  runtime: Atom.runtime(Socket.layerWebSocketConstructorGlobal),
  transport: Transport.live({ connect: Transport.socket(wsUrl), up: Say }),
  initial: StreamView.empty<UiContract.Payloads<typeof SynthesisUi>>(),
  step: StreamView.step,
  decode: SynthesisUi.decode,
  media: (frame) => (frame.channel === SPEAKER ? play(frame.bytes) : Effect.void),
})

const registry = AtomRegistry.make()

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`#${id} missing`)
  return el as T
}

const textEl = $<HTMLInputElement>("text")
const statusEl = $("status")
const historyEl = $("history")

const setStatus = (text: string, error = false): void => {
  statusEl.textContent = text
  statusEl.classList.toggle("err", error)
}

const render = (view: View): void => {
  historyEl.replaceChildren(
    ...Object.entries(view.data.line ?? {})
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, text]) => {
        const line = document.createElement("div")
        line.className = "entry"
        line.textContent = `› ${text}`
        return line
      }),
  )
  const problem = view.live.problem
  if (problem !== undefined) setStatus(`failed: ${problem}`, true)
}

registry.subscribe(
  session.state,
  (view) => {
    render(view)
    const speaker = view.channels[SPEAKER]
    if (player === null && speaker !== undefined) openPlayer(speaker.sampleRate ?? 48000)
  },
  { immediate: true },
)

// Lines typed before the session is open go out once it is.
const pending: Array<string> = []

registry.subscribe(session.connected, (connected) => {
  if (!connected) {
    closePlayer()
    // A problem already says why it closed.
    if (registry.get(session.state).live.problem === undefined) setStatus("session closed")
    return
  }
  setStatus("streaming · keep typing")
  pending.splice(0).forEach((text) => registry.set(session.send, Frame.message({ text })))
})

textEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return
  e.preventDefault()
  const text = textEl.value.trim()
  textEl.value = ""
  if (text.length === 0) return
  if (registry.get(session.connected)) {
    registry.set(session.send, Frame.message({ text }))
    return
  }
  pending.push(text)
  setStatus("connecting…")
  registry.set(session.connect, undefined)
})
