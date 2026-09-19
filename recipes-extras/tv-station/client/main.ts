/**
 * TV-station browser client.
 *
 * One `<video>` pointed at `/stream`, which is a single fragmented MP4
 * the server holds open forever. There is no per-clip fetching, no
 * preloading, no swapping and no acknowledgement: the server owns the
 * timeline and the browser just plays what arrives.
 *
 * The WebSocket carries no video. It is the listing, the now-playing
 * highlight, and the signal that starts the station.
 */

// A module, not a script: every recipe's client declares `$` and `setStatus`,
// and as scripts they would all share one global scope.
export {}

type ServerEvent =
  | {
      readonly type: "station-info"
      readonly channel: string
      readonly tagline: string
      readonly total: number | null
    }
  | {
      readonly type: "clip-planned"
      readonly index: number
      readonly kind: string
      readonly title: string
    }
  | { readonly type: "clip-ready"; readonly index: number }
  | {
      readonly type: "clip-start"
      readonly index: number
      readonly cycle: number
      readonly title: string
    }
  | { readonly type: "standby"; readonly index: number }

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const toggle = $<HTMLButtonElement>("toggle")
const statusEl = $<HTMLSpanElement>("status")
const channelLabel = $<HTMLHeadingElement>("channel")
const listing = $<HTMLOListElement>("listing")
const cycleSpan = $<HTMLSpanElement>("cycle")
const screen = $<HTMLVideoElement>("screen")

const setStatus = (text: string) => {
  statusEl.textContent = text
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/** Rows appear as titles arrive, since `--infinite` has no total to size to. */
const ensureSlot = (index: number): HTMLLIElement => {
  const existing = document.getElementById(`clip-${index}`)
  if (existing) return existing as HTMLLIElement
  const li = document.createElement("li")
  li.id = `clip-${index}`
  li.innerHTML =
    `<span class="num">${String(index + 1).padStart(2, "0")}</span>` +
    `<span class="kind"></span>` +
    `<span class="title" style="opacity:0.35">planning...</span>`
  listing.appendChild(li)
  return li
}

const fillSlot = (index: number, kind: string, title: string) => {
  const li = ensureSlot(index)
  const titleSpan = li.querySelector(".title") as HTMLSpanElement | null
  if (titleSpan) {
    titleSpan.textContent = title
    titleSpan.style.opacity = ""
  }
  const kindSpan = li.querySelector(".kind") as HTMLSpanElement | null
  if (kindSpan) kindSpan.textContent = kind
}

const highlight = (index: number) => {
  listing.querySelectorAll("li").forEach((li) => {
    li.classList.toggle("playing", li.id === `clip-${index}`)
  })
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

let socket: WebSocket | null = null

const handleEvent = (event: ServerEvent) => {
  switch (event.type) {
    case "station-info":
      channelLabel.textContent = `${event.channel} — ${event.tagline}`
      setStatus(event.total === null ? "on air" : `on air · ${event.total} clips`)
      break
    case "clip-planned":
      fillSlot(event.index, event.kind, event.title)
      break
    case "clip-ready":
      ensureSlot(event.index)
      break
    case "clip-start":
      highlight(event.index)
      cycleSpan.textContent = event.cycle > 0 ? `cycle ${event.cycle + 1}` : ""
      setStatus(event.title)
      break
    case "standby":
      highlight(-1)
      setStatus(`standby · rendering ${event.index + 1}`)
      break
  }
}

const start = () => {
  toggle.disabled = true
  setStatus("connecting...")
  channelLabel.textContent = "planning the channel..."

  const ws = new WebSocket(`ws://${location.host}/ws`)
  socket = ws

  ws.addEventListener("open", () => {
    toggle.disabled = false
    toggle.textContent = "Stop"
    // The station exists once the socket is up, so the stream has
    // something to attach to.
    screen.src = "/stream"
    screen.play().catch(() => setStatus("press play on the picture to start"))
  })
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return
    try {
      handleEvent(JSON.parse(e.data) as ServerEvent)
    } catch {
      // A frame this client does not understand is not worth stopping for.
    }
  })
  ws.addEventListener("close", () => {
    toggle.disabled = false
    setStatus("off air")
  })
  ws.addEventListener("error", () => setStatus("error"))
}

const stop = () => {
  socket?.close()
  socket = null
  screen.pause()
  screen.removeAttribute("src")
  screen.load()
  toggle.textContent = "Play"
  setStatus("idle")
  cycleSpan.textContent = ""
  listing.querySelectorAll("li").forEach((li) => li.classList.remove("playing"))
}

toggle.addEventListener("click", () => {
  if (socket) stop()
  else start()
})
