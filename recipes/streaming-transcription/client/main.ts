/**
 * Browser-side entry point. Bundled by `Bun.build` at server startup
 * and served as `/client.js`. Wires mic → WebSocket → DOM.
 *
 * Imperative on purpose — `getUserMedia`, `AudioContext`,
 * `AudioWorklet`, and `WebSocket` are all callback / event-driven web
 * APIs. Effect lives entirely on the server in this recipe.
 */

type TranscriptEvent =
  | { readonly _tag: "partial"; readonly text: string }
  | { readonly _tag: "final"; readonly text: string }
  | { readonly _tag: "error"; readonly code?: string; readonly message: string }
  | { readonly _tag: string }

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
const transcriptEl = $("transcript")

const setStatus = (text: string, error = false): void => {
  statusEl.textContent = text
  statusEl.classList.toggle("err", error)
}

const state = { final: "", partial: "" }

const render = (): void => {
  transcriptEl.textContent = ""
  if (state.final !== "") {
    const f = document.createElement("span")
    f.className = "final"
    f.textContent = state.final
    transcriptEl.appendChild(f)
  }
  if (state.partial !== "") {
    const p = document.createElement("span")
    p.className = "partial"
    p.textContent = (state.final !== "" ? " " : "") + state.partial
    transcriptEl.appendChild(p)
  }
}

const handleEvent = (e: TranscriptEvent): void => {
  if (e._tag === "partial") {
    state.partial = (e as { text: string }).text
    render()
  } else if (e._tag === "final") {
    const finalEv = e as { text: string }
    state.final = (state.final !== "" ? state.final + " " : "") + finalEv.text
    state.partial = ""
    render()
  } else if (e._tag === "error") {
    const err = e as { code?: string; message: string }
    setStatus(`error: ${err.code ?? "unknown"} — ${err.message}`, true)
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

const fetchConfig = async (): Promise<{ provider: string; sampleRate: number }> => {
  const res = await fetch("/config")
  return (await res.json()) as { provider: string; sampleRate: number }
}

const start = async (): Promise<void> => {
  toggleBtn.textContent = "Stop"
  setStatus("requesting microphone…")
  state.final = ""
  state.partial = ""
  render()

  let cfg: { provider: string; sampleRate: number }
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

  // Let the browser pick its native sample rate; the worklet resamples
  // to 16 kHz before frames go on the wire. Forcing the rate here can
  // cause some browsers to fill with zeros instead of resampling.
  const ctx = new AudioContext()
  if (ctx.state === "suspended") await ctx.resume()

  try {
    await ctx.audioWorklet.addModule("/audio-worklet.js")
  } catch (err) {
    setStatus(`audio worklet failed: ${(err as Error).message}`, true)
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
    stop()
    return
  }

  const source = ctx.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(ctx, "mic-worklet", {
    processorOptions: { sourceRate: ctx.sampleRate, targetRate: cfg.sampleRate },
  })
  setStatus(`connected · ${cfg.provider} · ${cfg.sampleRate} Hz`)
  source.connect(worklet)
  // Silent sink to keep the graph pulling on the worklet.
  const sink = ctx.createGain()
  sink.gain.value = 0
  worklet.connect(sink)
  sink.connect(ctx.destination)

  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`
  const ws = new WebSocket(wsUrl)
  ws.binaryType = "arraybuffer"

  active = { stream, ctx, ws, anchor }

  ws.addEventListener("open", () => {
    setStatus("connected · transcribing")
    worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(e.data)
    }
  })
  ws.addEventListener("message", (e) => {
    try {
      handleEvent(JSON.parse(e.data as string) as TranscriptEvent)
    } catch {
      /* ignore non-JSON */
    }
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
