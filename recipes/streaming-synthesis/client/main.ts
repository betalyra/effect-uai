/**
 * Browser entry point: one live session over `@effect-uai/ui`, opened on
 * the first Enter and held across lines. Each line goes up as a message;
 * the server declares the speech format with `channel-opened`, and the
 * speech arrives as media frames on that channel, played gap-free by a
 * `Media.pcmPlayer` at that format's rate. The player is one Effect per
 * connection, released when it ends; rendering is plain DOM.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Frame from "@effect-uai/ui/Frame"
import * as Media from "@effect-uai/ui/Media"
import * as StreamView from "@effect-uai/ui/StreamView"
import * as Transport from "@effect-uai/ui/Transport"
import type * as UiContract from "@effect-uai/ui/UiContract"
import { Effect, Option, Predicate, Queue, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import * as Socket from "effect/socket/Socket"
import { Say, SPEAKER, SynthesisUi } from "../contract.js"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

// The `@effect-uai/ui` player worklet, served by `app.ts`.
const PLAYER_WORKLET = "/worklets/player.mjs"

type View = StreamView.StreamView<UiContract.Payloads<typeof SynthesisUi>>

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

// Speech, held until the player is open.
const speaker = Effect.runSync(Queue.unbounded<Uint8Array>())

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`

const session = Atoms.live({
  runtime: Atom.runtime(Socket.layerWebSocketConstructorGlobal),
  transport: Transport.live({ connect: Transport.socket(wsUrl), up: Say }),
  initial: StreamView.empty<UiContract.Payloads<typeof SynthesisUi>>(),
  step: StreamView.step,
  decode: SynthesisUi.decode,
  media: (frame) =>
    frame.channel === SPEAKER ? Effect.asVoid(Queue.offer(speaker, frame.bytes)) : Effect.void,
})

const registry = AtomRegistry.make()

// ---------------------------------------------------------------------------
// Playback: one player per connection, released when it ends
// ---------------------------------------------------------------------------

/** The speech channel, once the server has declared its format. */
const declared = AtomRegistry.toStream(registry, session.state).pipe(
  Stream.map((view) => view.channels[SPEAKER]),
  Stream.filter(Predicate.isNotUndefined),
  Stream.runHead,
  Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: Effect.succeed })),
)

const playback = Effect.gen(function* () {
  yield* Queue.clear(speaker)
  const down = yield* declared
  const player = yield* Media.pcmPlayer({
    sampleRate: down.sampleRate ?? 48000,
    worklet: PLAYER_WORKLET,
  })
  yield* Stream.fromQueue(speaker).pipe(Stream.runForEach(player.push))
}).pipe(
  Effect.catch((error) =>
    Effect.sync(() => setStatus(`audio ${error.reason}: ${error.message}`, true)),
  ),
  Effect.scoped,
)

AtomRegistry.toStream(registry, session.connected).pipe(
  Stream.changes,
  Stream.switchMap((connected) => (connected ? Stream.fromEffect(playback) : Stream.empty)),
  Stream.runDrain,
  Effect.runFork,
)

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

registry.subscribe(session.state, render, { immediate: true })

// Lines typed before the session is open go out once it is.
const pending: Array<string> = []

registry.subscribe(session.connected, (connected) => {
  if (!connected) {
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
