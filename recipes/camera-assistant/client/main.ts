/**
 * Browser side. Bundled at server startup and served as `/client.js`. Wires
 * mic and camera to one WebSocket, and that socket to playback and the DOM.
 *
 * Imperative on purpose: `getUserMedia`, `AudioContext`, `AudioWorklet`,
 * `canvas` and `WebSocket` are callback-driven web APIs. Effect stays on the
 * server.
 *
 * The camera is a separate switch from the session, and either can come
 * first: the preview runs on its own, and frames start reaching the model as
 * soon as both are on.
 */

type StatusEvent =
  | { readonly type: "user-transcript"; readonly text: string; readonly final: boolean }
  | { readonly type: "assistant-started" }
  | { readonly type: "assistant-delta"; readonly text: string }
  | { readonly type: "assistant-done"; readonly reason: string }
  | { readonly type: "interrupted" }
  | { readonly type: "frames"; readonly count: number }
  | { readonly type: "tool-call"; readonly name: string; readonly arguments: string }
  | { readonly type: "tool-done"; readonly name: string }
  | { readonly type: "tool-cancelled"; readonly count: number }
  | { readonly type: "session-ending" }
  | { readonly type: "error"; readonly message: string }

// A module, not a script: every recipe's client declares `$`, `setStatus` and
// a `StatusEvent`, and as scripts they would all share one global scope.
export {}

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

/** Whichever element actually scrolls right now, or `null` for the page. */
const scroller = (): HTMLElement | null =>
  conversationEl.scrollHeight > conversationEl.clientHeight + 1 ? conversationEl : null

const distanceFromBottom = (): number => {
  const el = scroller()
  return el === null
    ? document.documentElement.scrollHeight - window.scrollY - window.innerHeight
    : el.scrollHeight - el.scrollTop - el.clientHeight
}

/**
 * Whether to keep following, decided by the reader's own scrolling rather than
 * measured when a delta lands. Deltas arrive faster than a scroll settles, so
 * measuring at append time reads a position still in motion, concludes the
 * reader has scrolled away, and stops following mid-answer.
 */
let following = true

const trackFollowing = (): void => {
  following = distanceFromBottom() <= NEAR_BOTTOM_PX
}

conversationEl.addEventListener("scroll", trackFollowing, { passive: true })
window.addEventListener("scroll", trackFollowing, { passive: true })

// Jumps rather than animates: a smooth scroll is still travelling when the
// next delta arrives, so it never catches up with a live transcript.
const followBottom = (): void => {
  if (!following) return
  const el = scroller()
  if (el === null) window.scrollTo({ top: document.documentElement.scrollHeight })
  else el.scrollTop = el.scrollHeight
}

// ---------------------------------------------------------------------------
// Conversation rendering
// ---------------------------------------------------------------------------

/** `raw` is the text as received, so trimming for display never loses it. */
type Block = { readonly text: HTMLSpanElement; raw: string }

let currentUser: Block | undefined
let currentAssistant: Block | undefined

const makeBlock = (role: "user" | "assistant" | "tool"): Block => {
  const el = document.createElement("div")
  el.className = `transcript ${role}`
  const roleLabel = document.createElement("div")
  roleLabel.className = "role"
  roleLabel.textContent = role
  const text = document.createElement("span")
  el.appendChild(roleLabel)
  el.appendChild(text)
  conversationEl.appendChild(el)
  followBottom()
  return { text, raw: "" }
}

/** Partials accumulate; the final transcript replaces the whole utterance. */
const showUser = (text: string, final: boolean): void => {
  if (!currentUser) currentUser = makeBlock("user")
  currentUser.raw = final ? text : currentUser.raw + text
  currentUser.text.textContent = currentUser.raw.trim()
  currentUser.text.classList.toggle("partial", !final)
  followBottom()
  if (final) currentUser = undefined
}

const appendAssistant = (text: string): void => {
  if (!currentAssistant) {
    currentAssistant = makeBlock("assistant")
    currentAssistant.text.classList.add("partial")
  }
  currentAssistant.raw += text
  currentAssistant.text.textContent = currentAssistant.raw.trim()
  followBottom()
}

const finishAssistant = (): void => {
  if (currentAssistant) currentAssistant.text.classList.remove("partial")
  currentAssistant = undefined
}

const handleStatus = (event: StatusEvent): void => {
  switch (event.type) {
    case "user-transcript":
      showUser(event.text, event.final)
      break
    case "assistant-started":
      active?.playbackNode.port.postMessage({ type: "reset" })
      break
    case "assistant-delta":
      setStatus("speaking…")
      appendAssistant(event.text)
      break
    case "assistant-done":
      setStatus(event.reason === "complete" ? "listening" : `listening (${event.reason})`)
      finishAssistant()
      break
    case "interrupted":
      active?.playbackNode.port.postMessage({ type: "clear" })
      finishAssistant()
      break
    case "frames":
      framesEl.textContent = `${event.count} frame${event.count === 1 ? "" : "s"} sent`
      break
    case "tool-call":
      makeBlock("tool").text.textContent = `${event.name}(${event.arguments})`
      followBottom()
      break
    case "tool-done":
      setStatus("speaking…")
      break
    case "tool-cancelled":
      if (event.count > 0) {
        makeBlock("tool").text.textContent = `${event.count} call(s) abandoned`
        followBottom()
      }
      break
    case "session-ending":
      setStatus("session ending soon", true)
      break
    case "error":
      setStatus(event.message, true)
      break
  }
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

type Session = {
  readonly stream: MediaStream
  readonly ctx: AudioContext
  readonly ws: WebSocket
  readonly anchor: HTMLAudioElement
  readonly playbackNode: AudioWorkletNode
}

let active: Session | undefined

const teardown = (s: Session): void => {
  try {
    s.stream.getTracks().forEach((t) => t.stop())
  } catch {
    /* ignore */
  }
  try {
    s.anchor.pause()
    s.anchor.srcObject = null
  } catch {
    /* ignore */
  }
  try {
    if (s.ws.readyState === WebSocket.OPEN || s.ws.readyState === WebSocket.CONNECTING) s.ws.close()
  } catch {
    /* ignore */
  }
  try {
    void s.ctx.close()
  } catch {
    /* ignore */
  }
}

/** The camera outlives the session: stopping one does not touch the other. */
const stop = (): void => {
  if (active !== undefined) {
    teardown(active)
    active = undefined
  }
  toggleBtn.textContent = "Start"
}

// Every frame we send carries a one-byte tag. Microphone PCM and JPEG bytes
// both cover every byte value, so nothing in the payload can be sniffed.
const AUDIO_FRAME = 0x00
const TEXT_FRAME = 0x01
const VIDEO_FRAME = 0x02

const tagged = (tag: number, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(payload.byteLength + 1)
  out[0] = tag
  out.set(payload, 1)
  return out
}

const encoder = new TextEncoder()

const pcmS16ToFloat32 = (bytes: Uint8Array): Float32Array => {
  const view = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  const out = new Float32Array(view.length)
  for (let i = 0; i < view.length; i++) {
    const v = view[i]!
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff
  }
  return out
}

// ---------------------------------------------------------------------------
// Camera
//
// A frame costs tokens on every turn it stays in context, so they are sent
// while the person is talking and for a moment after, rather than always.
// That gate is loudness only: it decides what the model is shown, never when
// it answers, which stays the server's own turn detection.
// ---------------------------------------------------------------------------

const FRAME_INTERVAL_MS = 1000
const LONGEST_SIDE_PX = 768
const SPEAKING_RMS = 0.02
const SPEAKING_TAIL_MS = 1500

let camera: { readonly stream: MediaStream; readonly timer: number } | undefined
let speakingUntil = 0
let sendNextFrame = false

const canvas = document.createElement("canvas")

const noteLoudness = (frame: Int16Array): void => {
  let sum = 0
  for (let i = 0; i < frame.length; i++) {
    const v = (frame[i] ?? 0) / 0x8000
    sum += v * v
  }
  if (Math.sqrt(sum / Math.max(1, frame.length)) > SPEAKING_RMS) {
    speakingUntil = Date.now() + SPEAKING_TAIL_MS
  }
}

const captureFrame = async (): Promise<void> => {
  // The preview can run before the session does; nothing to send until then.
  if (active === undefined || camera === undefined) return
  if (!sendNextFrame && Date.now() > speakingUntil) return
  sendNextFrame = false

  const width = videoEl.videoWidth
  const height = videoEl.videoHeight
  if (width === 0 || height === 0) return
  const scale = Math.min(1, LONGEST_SIDE_PX / Math.max(width, height))
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const ctx2d = canvas.getContext("2d")
  if (ctx2d === null) return
  ctx2d.drawImage(videoEl, 0, 0, canvas.width, canvas.height)

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.7),
  )
  if (blob === null || active.ws.readyState !== WebSocket.OPEN) return
  active.ws.send(tagged(VIDEO_FRAME, new Uint8Array(await blob.arrayBuffer())))
}

const startCamera = async (source: "camera" | "screen"): Promise<void> => {
  try {
    const stream =
      source === "screen"
        ? await navigator.mediaDevices.getDisplayMedia({ video: true })
        : await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "environment", width: { ideal: 1280 } },
          })
    videoEl.srcObject = stream
    viewportEl.classList.add("live")
    await videoEl.play()
    // One frame straight away, so pointing at something is enough even if the
    // question was already asked.
    sendNextFrame = true
    camera = { stream, timer: window.setInterval(() => void captureFrame(), FRAME_INTERVAL_MS) }
    cameraBtn.textContent = "Camera off"
  } catch (err) {
    setStatus(`camera denied: ${(err as Error).message}`, true)
  }
}

function stopCamera(): void {
  if (camera === undefined) return
  window.clearInterval(camera.timer)
  camera.stream.getTracks().forEach((t) => t.stop())
  camera = undefined
  videoEl.srcObject = null
  viewportEl.classList.remove("live")
  cameraBtn.textContent = "Camera on"
}

type WireConfig = {
  readonly micSampleRate: number
  readonly playbackSampleRate: number
  readonly source: "camera" | "screen"
  readonly capture: boolean
}

/** Read once at load, so the camera works before the session exists. */
const wire = fetch("/config")
  .then((r) => r.json() as Promise<WireConfig>)
  .then((cfg) => {
    cameraBtn.disabled = !cfg.capture
    if (!cfg.capture) framesEl.textContent = "frames come from disk"
    return cfg
  })

const start = async (): Promise<void> => {
  toggleBtn.textContent = "Stop"
  setStatus("requesting microphone…")

  let cfg: WireConfig
  try {
    cfg = await wire
  } catch (err) {
    setStatus(`config fetch failed: ${(err as Error).message}`, true)
    stop()
    return
  }

  let stream: MediaStream
  try {
    // The model listens while it speaks, so without echo cancellation it
    // hears its own voice through the speakers and interrupts itself.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch (err) {
    setStatus(`mic denied: ${(err as Error).message}`, true)
    stop()
    return
  }

  // Chrome and Safari produce silence from a `MediaStreamAudioSourceNode`
  // unless the stream is also consumed by an `<audio>` element.
  const anchor = new Audio()
  anchor.srcObject = stream
  anchor.muted = true
  try {
    await anchor.play()
  } catch {
    /* autoplay policy may reject; the source node usually still works */
  }

  const ctx = new AudioContext({ sampleRate: cfg.playbackSampleRate })
  if (ctx.state === "suspended") await ctx.resume()

  try {
    await ctx.audioWorklet.addModule("/mic-worklet.js")
    await ctx.audioWorklet.addModule("/playback-worklet.js")
  } catch (err) {
    setStatus(`audio worklet failed: ${(err as Error).message}`, true)
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
    stop()
    return
  }

  const source = ctx.createMediaStreamSource(stream)
  const micWorklet = new AudioWorkletNode(ctx, "mic-worklet", {
    processorOptions: { sourceRate: ctx.sampleRate, targetRate: cfg.micSampleRate },
  })
  source.connect(micWorklet)
  const sink = ctx.createGain()
  sink.gain.value = 0
  micWorklet.connect(sink)
  sink.connect(ctx.destination)

  const playbackNode = new AudioWorkletNode(ctx, "playback-worklet")
  playbackNode.connect(ctx.destination)

  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`
  const ws = new WebSocket(wsUrl)
  ws.binaryType = "arraybuffer"

  active = { stream, ctx, ws, anchor, playbackNode }

  ws.addEventListener("open", () => {
    setStatus("listening")
    // A camera that was already running shows the model something at once.
    if (camera !== undefined) sendNextFrame = true
    micWorklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const bytes = new Uint8Array(e.data)
      noteLoudness(new Int16Array(e.data))
      if (ws.readyState === WebSocket.OPEN) ws.send(tagged(AUDIO_FRAME, bytes))
    }
  })

  ws.addEventListener("message", (e) => {
    if (typeof e.data === "string") {
      try {
        handleStatus(JSON.parse(e.data) as StatusEvent)
      } catch {
        /* ignore non-JSON text */
      }
      return
    }
    const bytes = e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : (e.data as Uint8Array)
    playbackNode.port.postMessage(pcmS16ToFloat32(bytes))
  })

  ws.addEventListener("close", () => {
    if (active !== undefined) {
      setStatus("closed")
      stop()
    }
  })
  ws.addEventListener("error", () => {
    setStatus("ws error", true)
    stop()
  })
}

toggleBtn.addEventListener("click", () => {
  if (active === undefined) {
    void start()
  } else {
    setStatus("stopped")
    stop()
  }
})

cameraBtn.addEventListener("click", () => {
  if (camera !== undefined) {
    stopCamera()
    return
  }
  void wire.then((cfg) => startCamera(cfg.source))
})

composerEl.addEventListener("submit", (e) => {
  e.preventDefault()
  const text = inputEl.value.trim()
  if (text.length === 0 || active === undefined) return
  active.ws.send(tagged(TEXT_FRAME, encoder.encode(text)))
  showUser(text, true)
  inputEl.value = ""
})
