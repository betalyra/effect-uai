/**
 * Radio-station browser client: plain DOM over `@effect-uai/ui`.
 *
 * The station runs on the server; this page follows it as a session
 * stream folded by `StreamView` (the set, each track's state, the finished
 * tracks as media URLs) and plays the finished tracks in order with one
 * `<audio>`, wrapping round at the end of the set. Each track it starts is
 * reported back, which is what lets the server generate one track ahead,
 * and what a reloaded page resumes from.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Client from "@effect-uai/ui/Client"
import type * as Input from "@effect-uai/ui/Input"
import { StreamId } from "@effect-uai/ui/RunEvent"
import * as StreamView from "@effect-uai/ui/StreamView"
import * as Transport from "@effect-uai/ui/Transport"
import type * as UiContract from "@effect-uai/ui/UiContract"
import { Effect, Layer, Option } from "effect"
import { SecureRandom } from "effect/crypto"
import { FetchHttpClient, HttpClientRequest, HttpIncomingMessage } from "effect/http"
import { Atom, AtomRegistry } from "effect/reactivity"
import { ListeningBody, StationUi, StatusResponse, type TrackEntry } from "../contract.js"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

type View = StreamView.StreamView<UiContract.Payloads<typeof StationUi>>

// ---------------------------------------------------------------------------
// The station: the routes of app.ts as a session transport, state as a StreamView
// ---------------------------------------------------------------------------

const statusOf = (request: HttpClientRequest.HttpClientRequest) =>
  Client.execute(request).pipe(
    Effect.flatMap(HttpIncomingMessage.schemaBodyJson(StatusResponse)),
    Effect.map((status) => ({ ...status, streamId: StreamId.make(status.streamId) })),
  )

// Pressing Start is the one input: the server starts the station once.
type Play = { readonly play: true }

const transport = Transport.reconnect(
  Transport.sessionHttp({
    send: (_streamId, _input: Input.Sent<Play>) =>
      Effect.map(statusOf(HttpClientRequest.post("/play")), (status) => status.streamId),
    events: (_streamId, after) => HttpClientRequest.get("/events", { urlParams: { after } }),
  }),
)

const httpLayer = FetchHttpClient.layer
const runtime = Atom.runtime(Layer.mergeAll(httpLayer, SecureRandom.layerWebCrypto))

const station = Atoms.session({
  runtime,
  transport,
  initial: StreamView.empty<UiContract.Payloads<typeof StationUi>>(),
  step: StreamView.step,
  decode: StationUi.decode,
})

/** Tell the server which track is playing; nothing to wait for. */
const reportListening = (index: number) =>
  Effect.runFork(
    HttpClientRequest.post("/listening").pipe(
      HttpClientRequest.schemaBodyJson(ListeningBody)({ index }),
      Effect.flatMap(Client.execute),
      Effect.provide(httpLayer),
      Effect.ignore,
    ),
  )

// ---------------------------------------------------------------------------
// Playback: one audio element, the tracks in order
// ---------------------------------------------------------------------------

const audio = new Audio()

/** What this page plays; `null` until the listener presses Start or Listen. */
let player: { index: number; cycle: number; waiting: boolean } | null = null
let latest: View = StreamView.empty()

const trackUrl = (view: View, index: number): Option.Option<string> => {
  const media = view.media[`track-${index}`]
  return Option.fromNullishOr(media?.source._tag === "url" ? media.source.url : undefined)
}

/** Play the current track if it is ready; otherwise wait for the next state update. */
const playCurrent = () => {
  if (player === null) return
  const current = player
  Option.match(trackUrl(latest, current.index), {
    onNone: () => {
      current.waiting = true
    },
    onSome: (url) => {
      current.waiting = false
      audio.src = url
      audio.play().catch(() => (statusEl.textContent = "press Listen to start the sound"))
      reportListening(current.index)
    },
  })
  render(latest)
}

audio.addEventListener("ended", () => {
  if (player === null) return
  const total = latest.data.station?.["station"]?.total ?? 0
  const next = player.index + 1
  player =
    next < total
      ? { ...player, index: next }
      : { index: 0, cycle: player.cycle + 1, waiting: false }
  playCurrent()
})

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const toggle = $<HTMLButtonElement>("toggle")
const statusEl = $<HTMLSpanElement>("status")
const stationLabel = $<HTMLHeadingElement>("station")
const playlist = $<HTMLOListElement>("playlist")
const cycleSpan = $<HTMLSpanElement>("cycle")

const row = (index: number, track: TrackEntry | undefined) => {
  const li = document.createElement("li")
  li.classList.toggle("playing", player?.index === index && !player.waiting)
  const num = document.createElement("span")
  num.className = "num"
  num.textContent = String(index + 1).padStart(2, "0")
  const title = document.createElement("span")
  title.className = "title"
  title.textContent = track?.title ?? "planning..."
  if (track === undefined || track.status === "generating") title.style.opacity = "0.35"
  li.append(num, title)
  return li
}

const statusText = (view: View): string => {
  const problem = view.live.problem
  if (problem !== undefined) return `off air: ${problem} (see the server log)`
  if (player === null) return view.data.station === undefined ? "idle" : "on air"
  const title = view.data.track?.[String(player.index)]?.title
  return player.waiting ? `generating track ${player.index + 1}...` : (title ?? "on air")
}

function render(view: View) {
  latest = view
  const info = view.data.station?.["station"]
  if (info !== undefined) stationLabel.textContent = info.brief
  const tracks = view.data.track ?? {}
  playlist.replaceChildren(
    ...Array.from({ length: info?.total ?? 0 }, (_, index) => row(index, tracks[String(index)])),
  )
  statusEl.textContent = statusText(view)
  cycleSpan.textContent = player !== null && player.cycle > 0 ? `cycle ${player.cycle + 1}` : ""
  // A track this page was waiting for has just become ready.
  if (player?.waiting === true && Option.isSome(trackUrl(view, player.index))) playCurrent()
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const registry = AtomRegistry.make()
registry.subscribe(station.state, render, { immediate: true })

/** Start listening where the station is: the track the listener had reached, or the first. */
const listen = () => {
  toggle.disabled = true
  player = { index: Math.max(0, latest.live.listening ?? 0), cycle: 0, waiting: false }
  playCurrent()
}

toggle.addEventListener("click", () => {
  if (toggle.textContent === "Listen") return listen()
  statusEl.textContent = "planning the first track..."
  registry.set(station.submit, { play: true })
  listen()
})

// Already on air (this page reloaded, or another tab pressed Start): follow it,
// and offer Listen, since a browser only plays sound after a click.
Effect.runFork(
  statusOf(HttpClientRequest.get("/status")).pipe(
    Effect.tap((status) =>
      Effect.sync(() => {
        if (!status.playing) return
        toggle.textContent = "Listen"
        registry.set(station.open, status.streamId)
      }),
    ),
    Effect.provide(httpLayer),
    Effect.ignore,
  ),
)
