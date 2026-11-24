/**
 * Browser entry point, bundled at server startup and served as `/client.js`.
 *
 * One live session over `@effect-uai/ui`. The server opens the mic channel
 * at the rate its transcriber takes; the page records with `Media.mic` and
 * sends each frame on it. Each reply is a run that opens its own audio
 * channel; the audio plays through one `Media.pcmPlayer`, and a reply the
 * user cuts short with a stop word (`run-stopped`) drops what is still queued.
 *
 * The devices are one Effect per connection: each opens once the server
 * declares its channel, and all of them are released when the connection
 * ends. Rendering is plain DOM.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Frame from "@effect-uai/ui/Frame"
import * as Media from "@effect-uai/ui/Media"
import * as RunView from "@effect-uai/ui/RunView"
import * as StreamView from "@effect-uai/ui/StreamView"
import * as Transport from "@effect-uai/ui/Transport"
import type * as UiContract from "@effect-uai/ui/UiContract"
import { Effect, Option, Predicate, Queue, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import * as Socket from "effect/socket/Socket"
import { MIC, SPEAKER, Up, VoiceUi } from "../contract.js"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

// The `@effect-uai/ui` worklets, served by `app.ts`.
const MIC_WORKLET = "/worklets/mic.mjs"
const PLAYER_WORKLET = "/worklets/player.mjs"

type Payloads = UiContract.Payloads<typeof VoiceUi>
type View = StreamView.StreamView<Payloads>

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

// Reply audio, held until the player is open.
const speaker = Effect.runSync(Queue.unbounded<Uint8Array>())

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`

const session = Atoms.live({
  runtime: Atom.runtime(Socket.layerWebSocketConstructorGlobal),
  transport: Transport.live({ connect: Transport.socket(wsUrl), up: Up }),
  initial: StreamView.empty<Payloads>(),
  step: StreamView.step,
  decode: VoiceUi.decode,
  media: (frame) =>
    frame.channel === SPEAKER ? Effect.asVoid(Queue.offer(speaker, frame.bytes)) : Effect.void,
})

const registry = AtomRegistry.make()
const views = AtomRegistry.toStream(registry, session.state)

// ---------------------------------------------------------------------------
// Devices: the mic and the player, for as long as a connection lasts
// ---------------------------------------------------------------------------

/** A channel, once the server has opened it. */
const opened = (channel: number) =>
  views.pipe(
    Stream.map((view) => view.channels[channel]),
    Stream.filter(Predicate.isNotUndefined),
    Stream.runHead,
    Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: Effect.succeed })),
  )

/** Each reply the first time it is seen stopped. */
const stoppedReplies = views.pipe(
  Stream.mapAccum(
    () => new Set<string>(),
    (seen, view): readonly [Set<string>, ReadonlyArray<string>] => {
      const ids = StreamView.runsOf(view, "assistant").flatMap((reply) =>
        reply.status === "stopped" && reply.runId !== undefined && !seen.has(reply.runId)
          ? [reply.runId]
          : [],
      )
      return [new Set([...seen, ...ids]), ids]
    },
  ),
)

const devices = Effect.gen(function* () {
  yield* Queue.clear(speaker)
  yield* opened(MIC).pipe(
    Effect.flatMap((up) =>
      Media.mic({ sampleRate: up.sampleRate ?? 16000, worklet: MIC_WORKLET }).pipe(
        Stream.runForEach((bytes) =>
          Effect.sync(() => registry.set(session.send, Frame.media(MIC, bytes))),
        ),
      ),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        setStatus(`mic ${error.reason}: ${error.message}`, true)
        registry.set(session.disconnect, undefined)
      }),
    ),
    Effect.forkScoped,
  )
  // One player for the connection, at the rate the first reply declares.
  const down = yield* opened(SPEAKER)
  const player = yield* Media.pcmPlayer({
    sampleRate: down.sampleRate ?? 48000,
    worklet: PLAYER_WORKLET,
  })
  // A stop word ends the reply early: drop what is still queued, so it stops at once.
  yield* stoppedReplies.pipe(
    Stream.runForEach(() => Effect.andThen(Queue.clear(speaker), player.clear)),
    Effect.forkScoped,
  )
  yield* Stream.fromQueue(speaker).pipe(Stream.runForEach(player.push))
}).pipe(
  Effect.catch((error) =>
    Effect.sync(() => setStatus(`audio ${error.reason}: ${error.message}`, true)),
  ),
  Effect.scoped,
)

AtomRegistry.toStream(registry, session.connected).pipe(
  Stream.changes,
  Stream.switchMap((connected) => (connected ? Stream.fromEffect(devices) : Stream.empty)),
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

registry.subscribe(session.state, render, { immediate: true })

registry.subscribe(
  session.connected,
  (connected) => {
    toggleBtn.textContent = connected ? "Stop" : "Start"
  },
  { immediate: true },
)

toggleBtn.addEventListener("click", () => {
  if (registry.get(session.connected)) {
    setStatus("stopped")
    registry.set(session.disconnect, undefined)
  } else {
    setStatus("connecting…")
    registry.set(session.connect, undefined)
  }
})
