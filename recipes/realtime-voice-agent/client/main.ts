/**
 * Browser side. Bundled at server startup and served as `/client.js`.
 *
 * One live session over `@effect-uai/ui`. The server opens the mic channel at
 * the rate the model listens at; the page records with `Media.mic`. Each
 * answer is a run with its own audio channel, played through one
 * `Media.pcmPlayer`.
 *
 * Unlike the voice-loop client there is no stop-word watcher. The model hears
 * the microphone continuously and decides for itself that it has been
 * interrupted: the answer's run ends `run-stopped { reason: "barge-in" }`,
 * and the page stops the voice and reports how much of it was heard.
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
import { AgentUi, MIC, SPEAKER, Up } from "../contract.js"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

// The `@effect-uai/ui` worklets, served by `app.ts`.
const MIC_WORKLET = "/worklets/mic.mjs"
const PLAYER_WORKLET = "/worklets/player.mjs"

type Payloads = UiContract.Payloads<typeof AgentUi>
type View = StreamView.StreamView<Payloads>

// ---------------------------------------------------------------------------
// Playback: one player per session, at the rate the first answer declares
// ---------------------------------------------------------------------------

let player: { readonly scope: Scope.Closeable; readonly ready: Promise<Media.Player> } | null = null

const openPlayer = (sampleRate: number): void => {
  const scope = Effect.runSync(Scope.make())
  const ready = Effect.runPromise(
    Media.pcmPlayer({ sampleRate, worklet: PLAYER_WORKLET }).pipe(Scope.provide(scope)),
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
  decode: AgentUi.decode,
  media: (frame) =>
    frame.channel === SPEAKER ? withPlayer((p) => p.push(frame.bytes)) : Effect.void,
})

const registry = AtomRegistry.make()

/**
 * Stop the voice and report how much of it was heard, so the part that never
 * reached the speakers leaves the model's memory of what it said.
 */
const cutPlayback = withPlayer((p) =>
  Effect.gen(function* () {
    const playedMs = Math.round(yield* p.played)
    registry.set(session.send, Frame.message({ kind: "playback", channel: SPEAKER, playedMs }))
    yield* p.clear
  }),
)

// ---------------------------------------------------------------------------
// Mic: a fiber that sends `Media.mic` frames on the channel the session opened
// ---------------------------------------------------------------------------

let mic: Fiber.Fiber<void> | null = null

// The model listens while it speaks, so without echo cancellation it hears
// its own voice through the speakers and interrupts itself (on by default).
const startMic = (sampleRate: number) =>
  Media.mic({ sampleRate, worklet: MIC_WORKLET }).pipe(
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
const composerEl = $<HTMLFormElement>("composer")
const inputEl = $<HTMLInputElement>("text")

const setStatus = (text: string, error = false): void => {
  statusEl.textContent = text
  statusEl.classList.toggle("err", error)
}

/**
 * Follow new output, unless the reader has scrolled up to look at something.
 * Decided by the reader's own scrolling, not measured when a delta lands:
 * deltas arrive faster than a scroll settles.
 */
const NEAR_BOTTOM_PX = 120
let following = true

window.addEventListener(
  "scroll",
  () => {
    following =
      document.documentElement.scrollHeight - window.scrollY - window.innerHeight <= NEAR_BOTTOM_PX
  },
  { passive: true },
)

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
  if (following) window.scrollTo({ top: document.documentElement.scrollHeight })

  const live = view.live
  const last = StreamView.runsOf(view).at(-1)
  if (live.problem !== undefined) setStatus(live.problem, true)
  else if (live.error !== undefined) setStatus(live.error.message, true)
  else if (live["session-ending"] !== undefined) setStatus("session ending soon", true)
  else if (live.vad === true) setStatus("hearing you…")
  else setStatus(last?.status === "streaming" ? "speaking…" : "listening")
}

// Answers whose start or barge-in the player has already handled.
const started = new Set<string>()
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
      if (id === undefined) continue
      // Each answer's position is counted on its own: it is reported against one answer.
      if (!started.has(id)) {
        started.add(id)
        Effect.runFork(withPlayer((p) => p.reset))
      }
      if (answer.status === "stopped" && !cut.has(id)) {
        cut.add(id)
        Effect.runFork(cutPlayback)
      }
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
    started.clear()
    cut.clear()
    registry.set(session.connect, undefined)
  }
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
