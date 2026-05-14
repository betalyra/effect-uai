/**
 * Browser-side entry point. Bundled by `Bun.build` at server startup and
 * served as `/client.js`. Wires mic → WebSocket → server, server →
 * playback worklet + DOM.
 *
 * Imperative on purpose — `getUserMedia`, `AudioContext`, `AudioWorklet`,
 * and `WebSocket` are all callback-driven web APIs. Effect lives entirely
 * on the server in this recipe.
 */

type StatusEvent =
  | { readonly type: "user-partial"; readonly text: string }
  | { readonly type: "user-final"; readonly text: string }
  | { readonly type: "assistant-thinking" }
  | { readonly type: "assistant-delta"; readonly text: string }
  | { readonly type: "assistant-done"; readonly text: string }
  | { readonly type: "error"; readonly message: string }

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

const setStatus = (text: string, error = false): void => {
  statusEl.textContent = text
  statusEl.classList.toggle("err", error)
}

// ---------------------------------------------------------------------------
// Conversation rendering — keeps a running list of user / assistant blocks.
// Live partials and streaming assistant text mutate the trailing block.
// ---------------------------------------------------------------------------

type Block = {
  readonly el: HTMLDivElement
  readonly role: "user" | "assistant"
  readonly text: HTMLSpanElement
  partial: boolean
}

let currentUser: Block | undefined
let currentAssistant: Block | undefined

const makeBlock = (role: "user" | "assistant"): Block => {
  const el = document.createElement("div")
  el.className = `transcript ${role}`
  const roleLabel = document.createElement("div")
  roleLabel.className = "role"
  roleLabel.textContent = role
  const text = document.createElement("span")
  el.appendChild(roleLabel)
  el.appendChild(text)
  conversationEl.appendChild(el)
  return { el, role, text, partial: false }
}

const setUserPartial = (s: string): void => {
  if (!currentUser || !currentUser.partial) currentUser = makeBlock("user")
  currentUser.partial = true
  currentUser.text.textContent = s
  currentUser.text.classList.add("partial")
}

const commitUserFinal = (s: string): void => {
  if (!currentUser) currentUser = makeBlock("user")
  currentUser.text.textContent = s
  currentUser.text.classList.remove("partial")
  currentUser.partial = false
  currentUser = undefined // next partial starts a fresh block
}

const startAssistant = (): void => {
  currentAssistant = makeBlock("assistant")
  currentAssistant.text.classList.add("partial")
}

const appendAssistantDelta = (s: string): void => {
  if (!currentAssistant) startAssistant()
  currentAssistant!.text.textContent = (currentAssistant!.text.textContent ?? "") + s
}

const finishAssistant = (s: string): void => {
  if (!currentAssistant) currentAssistant = makeBlock("assistant")
  currentAssistant.text.textContent = s
  currentAssistant.text.classList.remove("partial")
  currentAssistant = undefined
}

const handleStatus = (event: StatusEvent): void => {
  switch (event.type) {
    case "user-partial":
      setUserPartial(event.text)
      break
    case "user-final":
      commitUserFinal(event.text)
      break
    case "assistant-thinking":
      setStatus("thinking…")
      startAssistant()
      break
    case "assistant-delta":
      setStatus("speaking…")
      appendAssistantDelta(event.text)
      break
    case "assistant-done":
      setStatus("listening")
      finishAssistant(event.text)
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

// ---------------------------------------------------------------------------
// PCM helpers — decode incoming binary frames (server TTS audio) into Float32
// for the playback worklet.
// ---------------------------------------------------------------------------

const pcmS16ToFloat32 = (bytes: Uint8Array): Float32Array => {
  // `bytes` is the wire frame as-is (s16le). Wrap as Int16 and convert.
  const view = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)
  const out = new Float32Array(view.length)
  for (let i = 0; i < view.length; i++) {
    const v = view[i]
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff
  }
  return out
}

// ---------------------------------------------------------------------------
// Start session
// ---------------------------------------------------------------------------

type WireConfig = { readonly micSampleRate: number; readonly playbackSampleRate: number }

const fetchConfig = async (): Promise<WireConfig> => {
  const res = await fetch("/config")
  return (await res.json()) as WireConfig
}

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
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    setStatus(`mic denied: ${(err as Error).message}`, true)
    stop()
    return
  }

  // Chrome / Safari quirk: `MediaStreamAudioSourceNode` produces silence
  // unless the underlying `MediaStream` is also being "consumed" by an
  // `<audio>` element. Muted playback is enough.
  const anchor = new Audio()
  anchor.srcObject = stream
  anchor.muted = true
  try {
    await anchor.play()
  } catch {
    /* autoplay policy may reject — the source node usually still works */
  }

  // Use the playback sample rate as the context rate so the playback worklet
  // doesn't need to resample. The mic worklet will downsample mic input from
  // ctx.sampleRate to cfg.micSampleRate.
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

  // Mic capture
  const source = ctx.createMediaStreamSource(stream)
  const micWorklet = new AudioWorkletNode(ctx, "mic-worklet", {
    processorOptions: { sourceRate: ctx.sampleRate, targetRate: cfg.micSampleRate },
  })
  source.connect(micWorklet)
  // Silent sink to keep the graph pulling on the mic worklet.
  const sink = ctx.createGain()
  sink.gain.value = 0
  micWorklet.connect(sink)
  sink.connect(ctx.destination)

  // Playback
  const playbackNode = new AudioWorkletNode(ctx, "playback-worklet")
  playbackNode.connect(ctx.destination)

  // WebSocket — sends binary mic frames, receives binary TTS frames + text
  // status frames.
  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`
  const ws = new WebSocket(wsUrl)
  ws.binaryType = "arraybuffer"

  active = { stream, ctx, ws, anchor, playbackNode }

  ws.addEventListener("open", () => {
    setStatus("listening")
    micWorklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data)
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
    // Binary frame = TTS audio bytes.
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
