/**
 * Browser side. Bundled at server startup and served as `/client.js`. Wires
 * mic to WebSocket, and WebSocket to the playback worklet and the DOM.
 *
 * Imperative on purpose: `getUserMedia`, `AudioContext`, `AudioWorklet` and
 * `WebSocket` are callback-driven web APIs. Effect stays on the server.
 *
 * Unlike the voice-loop client there is no stop-word watcher. The model hears
 * the microphone continuously and decides for itself that it has been
 * interrupted, so barge-in is the server telling us to flush playback.
 */

// A module, not a script: every recipe's client declares `$`, `setStatus` and
// a `StatusEvent`, and as scripts they would all share one global scope.
export {}

type StatusEvent =
  | { readonly type: "user-transcript"; readonly text: string; readonly final: boolean }
  | { readonly type: "assistant-started" }
  | { readonly type: "assistant-delta"; readonly text: string }
  | { readonly type: "assistant-done"; readonly reason: string }
  | { readonly type: "speech-started" }
  | { readonly type: "interrupted" }
  | { readonly type: "tool-call"; readonly name: string; readonly arguments: string }
  | { readonly type: "tool-done"; readonly name: string }
  | { readonly type: "tool-cancelled"; readonly count: number }
  | { readonly type: "session-ending" }
  | { readonly type: "error"; readonly message: string }

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
 * The page scrolls, not the transcript: it has no height of its own.
 */
const NEAR_BOTTOM_PX = 120

const distanceFromBottom = (): number =>
  document.documentElement.scrollHeight - window.scrollY - window.innerHeight

/**
 * Whether to keep following, decided by the reader's own scrolling rather than
 * measured when a delta lands. Deltas arrive faster than a scroll settles, so
 * measuring at append time reads a position still in motion, concludes the
 * reader has scrolled away, and stops following mid-answer.
 */
let following = true

window.addEventListener(
  "scroll",
  () => {
    following = distanceFromBottom() <= NEAR_BOTTOM_PX
  },
  { passive: true },
)

// Jumps rather than animates: a smooth scroll is still travelling when the
// next delta arrives, so it never catches up with a live transcript.
const followBottom = (): void => {
  if (following) window.scrollTo({ top: document.documentElement.scrollHeight })
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

const note = (role: "tool", message: string): void => {
  const block = makeBlock(role)
  block.text.textContent = message
  followBottom()
}

/**
 * Partials are token-sized deltas, so they accumulate and you watch the
 * sentence build. The final transcript is the server's own text for the whole
 * utterance, so it replaces what was accumulated rather than extending it.
 */
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
      // Each answer is counted on its own, since the position is reported
      // against one assistant item.
      playedMs = 0
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
    case "speech-started":
      setStatus("hearing you…")
      break
    case "interrupted":
      // The model has abandoned this answer. Stop the voice and report how far
      // the audio actually got, so the unheard part leaves its context.
      cutPlayback()
      finishAssistant()
      break
    case "tool-call":
      note("tool", `${event.name}(${event.arguments})`)
      break
    case "tool-done":
      setStatus("speaking…")
      break
    case "tool-cancelled":
      if (event.count > 0) note("tool", `${event.count} call(s) abandoned`)
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

const stop = (): void => {
  if (active !== undefined) {
    teardown(active)
    active = undefined
  }
  toggleBtn.textContent = "Start"
}

// Every frame we send carries a one-byte tag. The server cannot tell text
// from audio otherwise: microphone PCM contains every byte value, so there is
// nothing in the payload to sniff.
const AUDIO_FRAME = 0x00
const TEXT_FRAME = 0x01
const POSITION_FRAME = 0x02

const tagged = (tag: number, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(payload.byteLength + 1)
  out[0] = tag
  out.set(payload, 1)
  return out
}

const encoder = new TextEncoder()

/** How far into the answer now playing the worklet has actually got. */
let playedMs = 0

/**
 * Stop the voice and report how much of it was heard, so the part that never
 * reached the speakers leaves the model's memory of what it said.
 */
const cutPlayback = (): void => {
  if (active === undefined) return
  if (active.ws.readyState === WebSocket.OPEN) {
    active.ws.send(tagged(POSITION_FRAME, encoder.encode(String(Math.round(playedMs)))))
  }
  active.playbackNode.port.postMessage({ type: "clear" })
  playedMs = 0
}

const pcmS16ToFloat32 = (bytes: Uint8Array): Float32Array => {
  const view = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  const out = new Float32Array(view.length)
  for (let i = 0; i < view.length; i++) {
    const v = view[i]!
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff
  }
  return out
}

type WireConfig = { readonly micSampleRate: number; readonly playbackSampleRate: number }

const fetchConfig = async (): Promise<WireConfig> =>
  (await (await fetch("/config")).json()) as WireConfig

const start = async (): Promise<void> => {
  toggleBtn.textContent = "Stop"
  setStatus("requesting microphone…")

  let cfg: WireConfig
  try {
    cfg = await fetchConfig()
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
  playbackNode.port.onmessage = (e: MessageEvent) => {
    if (e.data?.type === "played") playedMs = e.data.ms as number
  }

  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`
  const ws = new WebSocket(wsUrl)
  ws.binaryType = "arraybuffer"

  active = { stream, ctx, ws, anchor, playbackNode }

  ws.addEventListener("open", () => {
    setStatus("listening")
    micWorklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(tagged(AUDIO_FRAME, new Uint8Array(e.data)))
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

composerEl.addEventListener("submit", (e) => {
  e.preventDefault()
  const text = inputEl.value.trim()
  if (text.length === 0 || active === undefined) return
  active.ws.send(tagged(TEXT_FRAME, encoder.encode(text)))
  showUser(text, true)
  inputEl.value = ""
})
