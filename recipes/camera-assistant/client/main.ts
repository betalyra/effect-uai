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
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Frame from "@effect-uai/ui/Frame"
import * as Media from "@effect-uai/ui/Media"
import type { RunId } from "@effect-uai/ui/RunEvent"
import * as RunView from "@effect-uai/ui/RunView"
import * as StreamView from "@effect-uai/ui/StreamView"
import * as Transport from "@effect-uai/ui/Transport"
import type * as UiContract from "@effect-uai/ui/UiContract"
import { Effect, Exit, Fiber, Scope, Stream } from "effect"
import { Atom, AtomRegistry } from "effect/reactivity"
import * as Socket from "effect/socket/Socket"
import { CAMERA, CameraUi, MIC, SPEAKER, Up } from "../contract.js"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

type Payloads = UiContract.Payloads<typeof CameraUi>
type View = StreamView.StreamView<Payloads>

// ---------------------------------------------------------------------------
// Playback: one player per session, at the rate the first answer declares
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
  decode: CameraUi.decode,
  media: (frame) =>
    frame.channel === SPEAKER ? withPlayer((p) => p.push(frame.bytes)) : Effect.void,
})

const registry = AtomRegistry.make()

const send = (frame: Frame.Frame<Up>) => Effect.sync(() => registry.set(session.send, frame))

// ---------------------------------------------------------------------------
// Mic, with a loudness gate for the camera
// ---------------------------------------------------------------------------

const SPEAKING_RMS = 0.02
const SPEAKING_TAIL_MS = 1500

let speakingUntil = 0
let sendNextFrame = false

let mic: Fiber.Fiber<void> | null = null

const startMic = (sampleRate: number) =>
  Media.mic({ sampleRate, worklet: Media.micWorklet }).pipe(
    Stream.tap((bytes) => send(Frame.media(MIC, bytes))),
    Media.level,
    Stream.runForEach((rms) =>
      Effect.sync(() => {
        if (rms > SPEAKING_RMS) speakingUntil = Date.now() + SPEAKING_TAIL_MS
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() => {
        setStatus(`mic ${error.reason}: ${error.message}`, true)
        registry.set(session.disconnect, undefined)
      }),
    ),
    Effect.runFork,
  )

// ---------------------------------------------------------------------------
// Camera: one still a second while it is on, sent while the person talks
// ---------------------------------------------------------------------------

let camera: Fiber.Fiber<void> | null = null

const startCamera = (source: "camera" | "screen") => {
  sendNextFrame = true
  viewportEl.classList.add("live")
  cameraBtn.textContent = "Camera off"
  camera = Media.camera({ source, fps: 1, maxSide: 768, quality: 0.7, preview: videoEl }).pipe(
    Stream.filter(() => {
      const wanted = sendNextFrame || Date.now() <= speakingUntil
      sendNextFrame = false
      return wanted
    }),
    Stream.runForEach((jpeg) => send(Frame.media(CAMERA, jpeg))),
    Effect.catch((error) =>
      Effect.sync(() => setStatus(`camera ${error.reason}: ${error.message}`, true)),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        camera = null
        viewportEl.classList.remove("live")
        cameraBtn.textContent = "Camera on"
      }),
    ),
    Effect.runFork,
  )
}

const stopCamera = (): void => {
  if (camera !== null) Effect.runFork(Fiber.interrupt(camera))
}

const stopDevices = (): void => {
  if (mic !== null) Effect.runFork(Fiber.interrupt(mic))
  mic = null
  stopCamera()
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

// Answers whose barge-in the player has already handled. This wire has no
// truncate, so a cut answer only stops the voice.
const cut = new Set<string>()

registry.subscribe(
  session.state,
  (view) => {
    note(view)
    render(view)
    const up = view.channels[MIC]
    if (mic === null && up !== undefined) mic = startMic(up.sampleRate ?? 16000)
    const down = view.channels[SPEAKER]
    if (player === null && down !== undefined) openPlayer(down.sampleRate ?? 24000)
    for (const answer of StreamView.runsOf(view, "assistant")) {
      const id = answer.runId
      if (id === undefined || answer.status !== "stopped" || cut.has(id)) continue
      cut.add(id)
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
    entries = []
    cut.clear()
    registry.set(session.connect, undefined)
  }
})

cameraBtn.addEventListener("click", () => {
  if (camera !== null) return stopCamera()
  startCamera(registry.get(session.state).live.source ?? "camera")
})

composerEl.addEventListener("submit", (e) => {
  e.preventDefault()
  const text = inputEl.value.trim()
  if (text.length === 0 || !registry.get(session.connected)) return
  registry.set(session.send, Frame.message({ kind: "say", text }))
  entries = [...entries, { kind: "typed", text }]
  render(registry.get(session.state))
  inputEl.value = ""
})
