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
 *
 * The devices are one Effect per connection: each opens once the server
 * declares its channel, and all of them are released when the connection
 * ends. Rendering is plain DOM.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Frame from "@effect-uai/ui/Frame"
import * as Media from "@effect-uai/ui/Media"
import type { RunId } from "@effect-uai/ui/RunEvent"
import * as RunView from "@effect-uai/ui/RunView"
import * as StreamView from "@effect-uai/ui/StreamView"
import * as Transport from "@effect-uai/ui/Transport"
import type * as UiContract from "@effect-uai/ui/UiContract"
import { Effect, Option, Predicate, Queue, Stream } from "effect"
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
  decode: AgentUi.decode,
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

/** Each answer once, the first time `idsOf` lists it. */
const once = (
  idsOf: (answers: ReadonlyArray<RunView.RunView<Payloads>>) => ReadonlyArray<string>,
) =>
  views.pipe(
    Stream.mapAccum(
      () => new Set<string>(),
      (seen, view): readonly [Set<string>, ReadonlyArray<string>] => {
        const ids = idsOf(StreamView.runsOf(view, "assistant")).filter((id) => !seen.has(id))
        return [new Set([...seen, ...ids]), ids]
      },
    ),
  )

const idOf = (answer: RunView.RunView<Payloads>): ReadonlyArray<string> =>
  answer.runId === undefined ? [] : [answer.runId]

// The model listens while it speaks, so without echo cancellation it hears
// its own voice through the speakers and interrupts itself (on by default).
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
  // One player for the connection, at the rate the first answer declares.
  const down = yield* opened(SPEAKER)
  const player = yield* Media.pcmPlayer({
    sampleRate: down.sampleRate ?? 24000,
    worklet: PLAYER_WORKLET,
  })
  // Each answer's position is counted on its own: it is reported against one answer.
  yield* once((answers) => answers.flatMap(idOf)).pipe(
    Stream.runForEach(() => player.reset),
    Effect.forkScoped,
  )
  // Stop the voice and report how much of it was heard, so the part that
  // never reached the speakers leaves the model's memory of what it said.
  yield* once((answers) => answers.filter((a) => a.status === "stopped").flatMap(idOf)).pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        yield* Queue.clear(speaker)
        const playedMs = Math.round(yield* player.played)
        registry.set(session.send, Frame.message({ kind: "playback", channel: SPEAKER, playedMs }))
        yield* player.clear
      }),
    ),
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

composerEl.addEventListener("submit", (e) => {
  e.preventDefault()
  const text = inputEl.value.trim()
  if (text.length === 0 || !registry.get(session.connected)) return
  registry.set(session.send, Frame.message({ kind: "say", text }))
  entries = [...entries, { kind: "typed", text }]
  render(registry.get(session.state))
  inputEl.value = ""
})
