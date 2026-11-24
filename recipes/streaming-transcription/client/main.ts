/**
 * Browser entry point, bundled at server startup and served as `/client.js`.
 *
 * One live session over `@effect-uai/ui`: the server opens the mic channel
 * with the rate its provider takes, the page starts the mic at that rate and
 * sends each `Media.mic` frame on the channel, and the transcript arrives as
 * utterance entries folded by `StreamView`.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Frame from "@effect-uai/ui/Frame"
import * as Media from "@effect-uai/ui/Media"
import type * as Projection from "@effect-uai/ui/Projection"
import * as StreamView from "@effect-uai/ui/StreamView"
import * as Transport from "@effect-uai/ui/Transport"
import type * as UiContract from "@effect-uai/ui/UiContract"
import { Effect, Option, Predicate, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import * as Socket from "effect/socket/Socket"
import { MIC, TranscriptUi, Up } from "../contract.js"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

// The `@effect-uai/ui` mic worklet, served by `app.ts`.
const MIC_WORKLET = "/worklets/mic.mjs"

type View = StreamView.StreamView<UiContract.Payloads<typeof TranscriptUi>>

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`

const session = Atoms.live({
  runtime: Atom.runtime(Socket.layerWebSocketConstructorGlobal),
  transport: Transport.live({ connect: Transport.socket(wsUrl), up: Up }),
  initial: StreamView.empty<UiContract.Payloads<typeof TranscriptUi>>(),
  step: StreamView.step,
  decode: TranscriptUi.decode,
  // Nothing comes down but entries.
  media: () => Effect.void,
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

const toggleBtn = $<HTMLButtonElement>("toggle")
const statusEl = $("status")
const transcriptEl = $("transcript")

const setStatus = (text: string, error = false): void => {
  statusEl.textContent = text
  statusEl.classList.toggle("err", error)
}

const utterances = (view: View): ReadonlyArray<Projection.Utterance> =>
  Object.entries(view.data.transcript ?? {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, u]) => u)

const render = (view: View): void => {
  transcriptEl.replaceChildren(
    ...utterances(view).map((u) => {
      const span = document.createElement("span")
      span.className = u.final ? "final" : "partial"
      span.textContent = `${u.text} `
      return span
    }),
  )
  const problem = view.live.problem
  if (problem !== undefined) setStatus(`error: ${problem}`, true)
}

// ---------------------------------------------------------------------------
// Mic: one per connection, released when it ends
// ---------------------------------------------------------------------------

/** The mic channel, once the session has said which rate to record at. */
const declared = AtomRegistry.toStream(registry, session.state).pipe(
  Stream.map((view) => view.channels[MIC]),
  Stream.filter(
    (channel): channel is StreamView.ChannelInfo =>
      Predicate.isNotUndefined(channel) && channel.direction === "up",
  ),
  Stream.runHead,
  Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: Effect.succeed })),
)

const recording = Effect.gen(function* () {
  const sampleRate = (yield* declared).sampleRate ?? 16000
  yield* Media.mic({ sampleRate, worklet: MIC_WORKLET }).pipe(
    Stream.zipWithIndex,
    Stream.runForEach(([bytes, n]) =>
      Effect.sync(() => {
        // The first frame shows the mic is live.
        if (n === 0) setStatus(`transcribing · ${sampleRate} Hz`)
        registry.set(session.send, Frame.media(MIC, bytes))
      }),
    ),
  )
}).pipe(
  Effect.catch((error) =>
    Effect.sync(() => {
      setStatus(`mic ${error.reason}: ${error.message}`, true)
      registry.set(session.disconnect, undefined)
    }),
  ),
)

AtomRegistry.toStream(registry, session.connected).pipe(
  Stream.changes,
  Stream.switchMap((connected) => (connected ? Stream.fromEffect(recording) : Stream.empty)),
  Stream.runDrain,
  Effect.runFork,
)

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
