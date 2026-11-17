/**
 * TV-station browser client: plain DOM over `@effect-uai/ui`.
 *
 * Two connections onto one station. The picture is a single fragmented
 * MP4 on `/stream`, which a `<video>` plays as it arrives. What is
 * happening to it is a session stream folded by `StreamView`: the
 * listing, each clip's render job, and what is on screen now.
 *
 * The station runs on the server, not in this tab: a reload, or a second
 * tab, follows the same channel from the start of its listing.
 */
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Client from "@effect-uai/ui/Client"
import type * as Input from "@effect-uai/ui/Input"
import { StreamId } from "@effect-uai/ui/RunEvent"
import * as StreamView from "@effect-uai/ui/StreamView"
import * as Transport from "@effect-uai/ui/Transport"
import type * as UiContract from "@effect-uai/ui/UiContract"
import { Effect, Layer, Match, Option } from "effect"
import { SecureRandom } from "effect/crypto"
import { FetchHttpClient, HttpClientRequest, HttpIncomingMessage } from "effect/http"
import { Atom, AtomRegistry } from "effect/reactivity"
import { type ClipEntry, type Screen, StationUi, StatusResponse } from "../contract.js"

// A module, not a script: recipe clients would otherwise share one global scope.
export {}

type View = StreamView.StreamView<UiContract.Payloads<typeof StationUi>>

// ---------------------------------------------------------------------------
// The station: the routes of app.ts as a session transport, state as a StreamView
// ---------------------------------------------------------------------------

/** The station's stream id from `/status` or `/play`. */
const streamIdOf = (request: HttpClientRequest.HttpClientRequest) =>
  Client.execute(request).pipe(
    Effect.flatMap(HttpIncomingMessage.schemaBodyJson(StatusResponse)),
    Effect.map((status) => ({ ...status, streamId: StreamId.make(status.streamId) })),
  )

// Pressing Play is the one input: the server starts the station once.
type Play = { readonly play: true }

const transport = Transport.reconnect(
  Transport.sessionHttp({
    send: (_streamId, _input: Input.Sent<Play>) =>
      Effect.map(streamIdOf(HttpClientRequest.post("/play")), (status) => status.streamId),
    events: (_streamId, after) => HttpClientRequest.get("/events", { urlParams: { after } }),
  }),
)

const runtime = Atom.runtime(Layer.mergeAll(FetchHttpClient.layer, SecureRandom.layerWebCrypto))

const station = Atoms.session({
  runtime,
  transport,
  initial: StreamView.empty<UiContract.Payloads<typeof StationUi>>(),
  step: StreamView.step,
  decode: StationUi.decode,
})

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const toggle = $<HTMLButtonElement>("toggle")
const statusEl = $<HTMLSpanElement>("status")
const channelLabel = $<HTMLHeadingElement>("channel")
const listing = $<HTMLOListElement>("listing")
const cycleSpan = $<HTMLSpanElement>("cycle")
const screen = $<HTMLVideoElement>("screen")

/** What a slot shows while its clip renders, from the job's last polled state. */
const progress = (clip: ClipEntry): string =>
  clip.render === undefined
    ? "planned"
    : Match.value(clip.render).pipe(
        Match.tagsExhaustive({
          Pending: (s) =>
            s.queuePosition === undefined ? "queued" : `queued (${s.queuePosition} ahead)`,
          Running: () => "rendering",
          Succeeded: () => "",
          Failed: (s) => `failed: ${s.error}`,
        }),
      )

const row = (clip: ClipEntry, onAir: Option.Option<number>, file: Option.Option<string>) => {
  const li = document.createElement("li")
  li.classList.toggle("playing", Option.contains(onAir, clip.index))
  const cell = (className: string, text: string) => {
    const span = document.createElement("span")
    span.className = className
    span.textContent = text
    return span
  }
  const title = Option.match(file, {
    onNone: () => cell("title", clip.title),
    onSome: (url) => {
      const link = document.createElement("a")
      link.className = "title"
      link.href = url
      link.textContent = clip.title
      return link
    },
  })
  li.append(
    cell("num", String(clip.index + 1).padStart(2, "0")),
    cell("kind", clip.kind),
    title,
    cell("progress", progress(clip)),
  )
  return li
}

const onScreen = (screenNow: Screen | undefined): string =>
  screenNow === undefined
    ? "on air"
    : Match.value(screenNow).pipe(
        Match.tagsExhaustive({
          clip: (s) => s.title,
          standby: (s) => `standby · rendering ${s.next + 1}`,
        }),
      )

const render = (view: View) => {
  const info = view.data.station?.["station"]
  if (info !== undefined) {
    channelLabel.textContent = `${info.channel} · ${info.tagline}`
    // The station is running once it has said what it is: the picture is there to play.
    if (!screen.src) {
      screen.src = "/stream"
      screen.play().catch(() => (statusEl.textContent = "press play on the picture to start"))
    }
  }
  const screenNow = view.live.screen
  const onAir = Option.fromNullishOr(screenNow).pipe(
    Option.flatMap((s) => (s._tag === "clip" ? Option.some(s.index) : Option.none())),
  )
  statusEl.textContent = Match.value({ problem: view.live.problem, info }).pipe(
    Match.when({ problem: Match.string }, (s) => `off air: ${s.problem} (see the server log)`),
    Match.when({ info: Match.undefined }, () => statusEl.textContent),
    Match.orElse(() => onScreen(screenNow)),
  )
  cycleSpan.textContent =
    screenNow?._tag === "clip" && screenNow.cycle > 0 ? `cycle ${screenNow.cycle + 1}` : ""
  const clips = Object.values(view.data.clip ?? {}).sort((a, b) => a.index - b.index)
  listing.replaceChildren(
    ...clips.map((clip) => {
      const media = view.media[`clip-${clip.index}`]
      const file = Option.fromNullishOr(media?.source._tag === "url" ? media.source.url : undefined)
      return row(clip, onAir, file)
    }),
  )
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const registry = AtomRegistry.make()
registry.subscribe(station.state, render, { immediate: true })

toggle.addEventListener("click", () => {
  toggle.disabled = true
  statusEl.textContent = "starting the channel..."
  channelLabel.textContent = "planning the channel..."
  registry.set(station.submit, { play: true })
})

// Already on air (another tab pressed Play, or this one reloaded): follow it from the start.
Effect.runFork(
  streamIdOf(HttpClientRequest.get("/status")).pipe(
    Effect.tap((status) =>
      Effect.sync(() => {
        if (!status.playing) return
        toggle.disabled = true
        registry.set(station.open, status.streamId)
      }),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.ignore,
  ),
)
