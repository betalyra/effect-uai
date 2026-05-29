/**
 * Radio-station browser client.
 *
 * Single MediaSource + audio/mpeg SourceBuffer. The server forwards
 * all tracks' MP3 chunks back-to-back into the same buffer, so audio
 * plays continuously. Track boundaries come from JSON control frames
 * (`station-planned` / `track-start` / `track-end`); the client
 * highlights the current track in the playlist and sends a
 * `track-ended` ACK once playback crosses each track's end position
 * (used to backpressure server-side generation against actual listening
 * time).
 *
 * MSE quirks handled:
 *   - `appendBuffer` can only run when the buffer isn't `updating`, so
 *     incoming chunks land in a small queue and are drained on
 *     `updateend`.
 *   - `track-end` JSON may arrive while chunks for that track are still
 *     pending — we capture `buffered.end(0)` only once the queue has
 *     drained, so the position is accurate.
 */

type ServerEvent =
  | { readonly type: "station-info"; readonly brief: string; readonly total: number }
  | { readonly type: "track-planned"; readonly index: number; readonly title: string }
  | {
      readonly type: "track-start"
      readonly index: number
      readonly cycle: number
      readonly title: string
    }
  | { readonly type: "track-end"; readonly index: number }

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const toggle = $<HTMLButtonElement>("toggle")
const statusEl = $<HTMLSpanElement>("status")
const stationLabel = $<HTMLHeadingElement>("station")
const playlist = $<HTMLOListElement>("playlist")
const cycleSpan = $<HTMLSpanElement>("cycle")

const setStatus = (text: string) => {
  statusEl.textContent = text
}

type Session = {
  readonly ws: WebSocket
  readonly audio: HTMLAudioElement
  readonly sourceBuffer: SourceBuffer
  readonly appendQueue: Array<ArrayBuffer>
  readonly trackEndMarkers: Array<{ readonly index: number; readonly endSec: number }>
  pendingEndIndex: number | null
}

let session: Session | null = null

const renderPlaylistSlots = (total: number) => {
  playlist.innerHTML = ""
  for (let i = 0; i < total; i++) {
    const li = document.createElement("li")
    li.id = `track-${i}`
    li.innerHTML =
      `<span class="num">${String(i + 1).padStart(2, "0")}</span>` +
      `<span class="title" style="opacity:0.35">planning...</span>`
    playlist.appendChild(li)
  }
}

const fillSlot = (index: number, title: string) => {
  const li = document.getElementById(`track-${index}`)
  if (!li) return
  const titleSpan = li.querySelector(".title") as HTMLSpanElement | null
  if (titleSpan) {
    titleSpan.textContent = title
    titleSpan.style.opacity = ""
  }
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  )

const highlightTrack = (index: number) => {
  playlist.querySelectorAll("li").forEach((li, i) => {
    li.classList.toggle("playing", i === index)
  })
}

const processNextAppend = (s: Session) => {
  if (s.sourceBuffer.updating || s.appendQueue.length === 0) return
  s.sourceBuffer.appendBuffer(s.appendQueue.shift()!)
}

const captureTrackEnd = (s: Session) => {
  if (s.pendingEndIndex === null) return
  const endSec = s.sourceBuffer.buffered.length > 0 ? s.sourceBuffer.buffered.end(0) : 0
  s.trackEndMarkers.push({ index: s.pendingEndIndex, endSec })
  s.pendingEndIndex = null
}

const onTimeUpdate = (s: Session) => () => {
  if (s.trackEndMarkers.length === 0) return
  const next = s.trackEndMarkers[0]!
  if (s.audio.currentTime >= next.endSec - 0.1) {
    s.trackEndMarkers.shift()
    s.ws.send(JSON.stringify({ type: "track-ended" }))
  }
}

const handleEvent = (s: Session, event: ServerEvent) => {
  switch (event.type) {
    case "station-info":
      stationLabel.textContent = event.brief
      renderPlaylistSlots(event.total)
      break
    case "track-planned":
      fillSlot(event.index, event.title)
      break
    case "track-start":
      highlightTrack(event.index)
      cycleSpan.textContent = event.cycle > 0 ? `cycle ${event.cycle + 1}` : ""
      break
    case "track-end":
      s.pendingEndIndex = event.index
      // If we're already caught up, record immediately.
      if (!s.sourceBuffer.updating && s.appendQueue.length === 0) {
        captureTrackEnd(s)
      }
      break
  }
}

const start = async () => {
  toggle.disabled = true
  setStatus("connecting...")

  const audio = new Audio()
  audio.autoplay = true
  const mediaSource = new MediaSource()
  audio.src = URL.createObjectURL(mediaSource)
  await new Promise<void>((resolve) =>
    mediaSource.addEventListener("sourceopen", () => resolve(), { once: true }),
  )
  const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg")

  const ws = new WebSocket(`ws://${location.host}/ws`)
  ws.binaryType = "arraybuffer"

  const s: Session = {
    ws,
    audio,
    sourceBuffer,
    appendQueue: [],
    trackEndMarkers: [],
    pendingEndIndex: null,
  }
  session = s

  sourceBuffer.addEventListener("updateend", () => {
    if (s.appendQueue.length > 0) {
      processNextAppend(s)
    } else if (s.pendingEndIndex !== null) {
      captureTrackEnd(s)
    }
  })

  audio.addEventListener("timeupdate", onTimeUpdate(s))

  ws.addEventListener("open", () => setStatus("on air"))
  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") {
      try {
        handleEvent(s, JSON.parse(e.data) as ServerEvent)
      } catch {
        // ignore
      }
      return
    }
    s.appendQueue.push(e.data as ArrayBuffer)
    processNextAppend(s)
  })
  ws.addEventListener("close", () => setStatus("disconnected"))
  ws.addEventListener("error", () => setStatus("error"))

  try {
    await audio.play()
  } catch {
    // Autoplay can be blocked; the user gesture from the click should
    // satisfy most browsers. If not, audio will start once they
    // interact with the page elsewhere.
  }

  toggle.disabled = false
  toggle.textContent = "Stop"
}

const stop = () => {
  if (!session) return
  session.ws.close()
  session.audio.pause()
  session = null
  toggle.textContent = "Start"
  setStatus("idle")
  cycleSpan.textContent = ""
  playlist.querySelectorAll("li").forEach((li) => li.classList.remove("playing"))
}

toggle.addEventListener("click", () => {
  if (session) {
    stop()
  } else {
    start().catch((err) => {
      setStatus(`failed: ${err instanceof Error ? err.message : String(err)}`)
      stop()
    })
  }
})
