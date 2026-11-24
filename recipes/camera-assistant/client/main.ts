/**
 * Browser side. Bundled at server startup and served as `/client.js`.
 *
 * One live session over `@effect-uai/ui`: the mic up on one channel, camera
 * stills up on another, the model's voice down on a third. The session
 * declares the camera channel only when the page is the one supplying frames,
 * and says which device to capture; until it does, the camera switch stays off.
 *
 * Frames cost tokens on every turn they stay in context, so they go up only
 * while the person is talking and for a moment after (a loudness gate over
 * `Media.level`), plus one straight away when the camera comes on. The gate
 * decides what the model is shown, never when it answers: that stays the
 * model's own turn detection.
 *
 * The devices are one Effect per connection: each opens once the server
 * declares its channel (the camera also needs its switch on), and all of
 * them are released when the connection ends. Rendering is plain DOM.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Frame from "@effect-uai/ui/Frame"
import * as Media from "@effect-uai/ui/Media"
import type { RunId } from "@effect-uai/ui/RunEvent"
import * as RunView from "@effect-uai/ui/RunView"
import * as StreamView from "@effect-uai/ui/StreamView"
import * as Transport from "@effect-uai/ui/Transport"
import type * as UiContract from "@effect-uai/ui/UiContract"
import { Clock, Effect, Option, Predicate, Queue, Ref, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import * as Socket from "effect/socket/Socket"
import { CAMERA, CameraUi, MIC, SPEAKER, Up } from "../contract.js"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

// The `@effect-uai/ui` worklets, served by `app.ts`.
const MIC_WORKLET = "/worklets/mic.mjs"
const PLAYER_WORKLET = "/worklets/player.mjs"

type Payloads = UiContract.Payloads<typeof CameraUi>
type View = StreamView.StreamView<Payloads>

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

// Answer audio, held until the player is open.
const speaker = Effect.runSync(Queue.unbounded<Uint8Array>())

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`

const session = Atoms.live({
  runtime: Atom.runtime(Socket.layerWebSocketConstructorGlobal),
  transport: Transport.live({ connect: Transport.socket(wsUrl), up: Up }),
  initial: StreamView.empty<Payloads>(),
  step: StreamView.step,
  decode: CameraUi.decode,
  media: (frame) =>
    frame.channel === SPEAKER ? Effect.asVoid(Queue.offer(speaker, frame.bytes)) : Effect.void,
})

/** The camera switch. */
const cameraOn = Atom.make(false).pipe(Atom.keepAlive)

const registry = AtomRegistry.make()
const views = AtomRegistry.toStream(registry, session.state)

const send = (frame: Frame.Frame<Up>) => Effect.sync(() => registry.set(session.send, frame))

// ---------------------------------------------------------------------------
// Devices: the mic, the camera and the player, for as long as a connection lasts
// ---------------------------------------------------------------------------

const SPEAKING_RMS = 0.02
const SPEAKING_TAIL_MS = 1500

/** A channel, once the server has opened it. */
const opened = (channel: number) =>
  views.pipe(
    Stream.map((view) => view.channels[channel]),
    Stream.filter(Predicate.isNotUndefined),
    Stream.runHead,
    Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: Effect.succeed })),
  )

/** Each answer the first time it is seen stopped. */
const stoppedAnswers = views.pipe(
  Stream.mapAccum(
    () => new Set<string>(),
    (seen, view): readonly [Set<string>, ReadonlyArray<string>] => {
      const ids = StreamView.runsOf(view, "assistant").flatMap((answer) =>
        answer.status === "stopped" && answer.runId !== undefined && !seen.has(answer.runId)
          ? [answer.runId]
          : [],
      )
      return [new Set([...seen, ...ids]), ids]
    },
  ),
)

/** One still a second from the device the session names, while the switch is on. */
const stills = Stream.unwrap(
  Effect.sync(() =>
    Media.camera({
      source: registry.get(session.state).live.source ?? "camera",
      fps: 1,
      maxSide: 768,
      quality: 0.7,
      preview: videoEl,
    }),
  ),
).pipe(
  Stream.catch((error) =>
    Stream.fromEffect(
      Effect.sync(() => {
        setStatus(`camera ${error.reason}: ${error.message}`, true)
        registry.set(cameraOn, false)
      }),
    ).pipe(Stream.drain),
  ),
)

const devices = Effect.gen(function* () {
  yield* Queue.clear(speaker)
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.set(cameraOn, false)))
  const speakingUntil = yield* Ref.make(0)

  yield* opened(MIC).pipe(
    Effect.flatMap((up) =>
      Media.mic({ sampleRate: up.sampleRate ?? 16000, worklet: MIC_WORKLET }).pipe(
        Stream.tap((bytes) => send(Frame.media(MIC, bytes))),
        Media.level,
        Stream.filter((rms) => rms > SPEAKING_RMS),
        Stream.runForEach(() =>
          Effect.flatMap(Clock.currentTimeMillis, (now) =>
            Ref.set(speakingUntil, now + SPEAKING_TAIL_MS),
          ),
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

  // Each time the switch goes on: the first still at once, then only while the person talks.
  yield* AtomRegistry.toStream(registry, cameraOn).pipe(
    Stream.changes,
    Stream.switchMap((on) =>
      on
        ? stills.pipe(
            Stream.zipWithIndex,
            Stream.filterEffect(([, n]) =>
              n === 0
                ? Effect.succeed(true)
                : Effect.zipWith(
                    Clock.currentTimeMillis,
                    Ref.get(speakingUntil),
                    (now, until) => now <= until,
                  ),
            ),
          )
        : Stream.empty,
    ),
    Stream.runForEach(([jpeg]) => send(Frame.media(CAMERA, jpeg))),
    Effect.forkScoped,
  )

  // One player for the connection, at the rate the first answer declares.
  const down = yield* opened(SPEAKER)
  const player = yield* Media.pcmPlayer({
    sampleRate: down.sampleRate ?? 24000,
    worklet: PLAYER_WORKLET,
  })
  // This wire has no truncate, so a cut answer only stops the voice.
  yield* stoppedAnswers.pipe(
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
const cameraBtn = $<HTMLButtonElement>("camera")
const videoEl = $<HTMLVideoElement>("preview")
const viewportEl = $("viewport")
const statusEl = $("status")
const framesEl = $("frames")
const conversationEl = $("conversation")
const composerEl = $<HTMLFormElement>("composer")
const inputEl = $<HTMLInputElement>("text")

const setStatus = (text: string, error = false): void => {
  statusEl.textContent = text
  statusEl.classList.toggle("err", error)
}

/**
 * Follow new output, unless the reader has scrolled up to look at something.
 * The transcript is its own scroller in the two-column layout and the page is
 * the scroller in the narrow one, so whichever it is, follow that.
 */
const NEAR_BOTTOM_PX = 120

const scroller = (): HTMLElement | null =>
  conversationEl.scrollHeight > conversationEl.clientHeight + 1 ? conversationEl : null

const distanceFromBottom = (): number => {
  const el = scroller()
  return el === null
    ? document.documentElement.scrollHeight - window.scrollY - window.innerHeight
    : el.scrollHeight - el.scrollTop - el.clientHeight
}

// Decided by the reader's own scrolling: deltas arrive faster than a scroll settles.
let following = true
const trackFollowing = (): void => {
  following = distanceFromBottom() <= NEAR_BOTTOM_PX
}
conversationEl.addEventListener("scroll", trackFollowing, { passive: true })
window.addEventListener("scroll", trackFollowing, { passive: true })

const followBottom = (): void => {
  if (!following) return
  const el = scroller()
  if (el === null) window.scrollTo({ top: document.documentElement.scrollHeight })
  else el.scrollTop = el.scrollHeight
}

const block = (role: "user" | "assistant" | "tool", text: string, partial = false) => {
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

// ---------------------------------------------------------------------------
// Rendering, in the order things first appeared. What the user said can
// arrive after the answer it prompted, so neither list orders the other.
// ---------------------------------------------------------------------------

type Entry =
  | { readonly kind: "heard"; readonly id: string }
  | { readonly kind: "typed"; readonly text: string }
  | { readonly kind: "answer"; readonly id: RunId }

let entries: ReadonlyArray<Entry> = []

const note = (view: View): void => {
  const known = new Set(entries.flatMap((e) => (e.kind === "typed" ? [] : [`${e.kind}:${e.id}`])))
  const heard = Object.keys(view.data.transcript ?? {}).map((id): Entry => ({ kind: "heard", id }))
  const answers = view.order.map((id): Entry => ({ kind: "answer", id }))
  entries = [
    ...entries,
    ...[...heard, ...answers].filter((e) => e.kind !== "typed" && !known.has(`${e.kind}:${e.id}`)),
  ]
}

const toolLine = (tool: Extract<RunView.Block<Payloads>, { type: "tool" }>): string => {
  const call = `${tool.name}(${JSON.stringify(tool.input ?? {})})`
  if (tool.outcome === undefined) return `${call} …`
  return tool.outcome._tag === "Success" ? call : `${call}: ${String(tool.outcome.error)}`
}

const render = (view: View): void => {
  conversationEl.replaceChildren(
    ...entries.flatMap((entry): ReadonlyArray<HTMLElement> => {
      if (entry.kind === "typed") return [block("user", entry.text)]
      if (entry.kind === "heard") {
        const u = view.data.transcript?.[entry.id]
        return u === undefined ? [] : [block("user", u.text, !u.final)]
      }
      const answer = view.runs[entry.id]
      if (answer === undefined) return []
      const tools = answer.blocks.flatMap((b) =>
        b.type === "tool" ? [block("tool", toolLine(b))] : [],
      )
      const text = RunView.text(answer).trim()
      return [
        ...tools,
        ...(text === "" ? [] : [block("assistant", text, answer.status === "streaming")]),
      ]
    }),
  )
  followBottom()

  const live = view.live
  framesEl.textContent = live.frames === undefined ? "" : `${live.frames} frames shown`
  // The camera switch exists only while the session takes frames from the page.
  cameraBtn.disabled = view.channels[CAMERA] === undefined
  const last = StreamView.runsOf(view).at(-1)
  if (live.problem !== undefined) setStatus(live.problem, true)
  else if (live.error !== undefined) setStatus(live.error.message, true)
  else if (live["session-ending"] !== undefined) setStatus("session ending soon", true)
  else setStatus(last?.status === "streaming" ? "speaking…" : "listening")
}

registry.subscribe(
  session.state,
  (view) => {
    note(view)
    render(view)
  },
  { immediate: true },
)

registry.subscribe(
  session.connected,
  (connected) => {
    toggleBtn.textContent = connected ? "Stop" : "Start"
  },
  { immediate: true },
)

registry.subscribe(
  cameraOn,
  (on) => {
    viewportEl.classList.toggle("live", on)
    cameraBtn.textContent = on ? "Camera off" : "Camera on"
  },
  { immediate: true },
)

toggleBtn.addEventListener("click", () => {
  if (registry.get(session.connected)) {
    setStatus("stopped")
    registry.set(session.disconnect, undefined)
  } else {
    setStatus("connecting…")
    entries = []
    registry.set(session.connect, undefined)
  }
})

cameraBtn.addEventListener("click", () => registry.set(cameraOn, !registry.get(cameraOn)))

composerEl.addEventListener("submit", (e) => {
  e.preventDefault()
  const text = inputEl.value.trim()
  if (text.length === 0 || !registry.get(session.connected)) return
  registry.set(session.send, Frame.message({ kind: "say", text }))
  entries = [...entries, { kind: "typed", text }]
  render(registry.get(session.state))
  inputEl.value = ""
})
