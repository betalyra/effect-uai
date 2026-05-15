/**
 * Browser entry point: a single WebSocket per session, each Enter
 * pushes another line into the upstream TTS pipeline. PCM chunks come
 * back as binary frames and flow into a ring-buffered
 * `AudioWorkletNode` for gap-free playback.
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (el === null) throw new Error(`#${id} missing`)
  return el as T
}

const textEl = $<HTMLInputElement>("text")
const statusEl = $("status")
const historyEl = $("history")

const setStatus = (text: string, error = false): void => {
  statusEl.textContent = text
  statusEl.classList.toggle("err", error)
}

const appendHistory = (text: string): void => {
  const line = document.createElement("div")
  line.className = "entry"
  line.textContent = text
  historyEl.appendChild(line)
}

const SAMPLE_RATE = 48000

const pcmToFloat32 = (bytes: Uint8Array): Float32Array => {
  const length = bytes.length / 2
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const s = view.getInt16(i * 2, true)
    out[i] = s < 0 ? s / 0x8000 : s / 0x7fff
  }
  return out
}

// ---------------------------------------------------------------------------
// Session — lazily created on the first Enter; held open across submissions.
// ---------------------------------------------------------------------------

type Session = {
  readonly ws: WebSocket
  readonly ctx: AudioContext
  readonly worklet: AudioWorkletNode
  readonly close: () => Promise<void>
}

let session: Session | undefined

const openSession = async (): Promise<Session> => {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  if (ctx.state === "suspended") await ctx.resume()
  await ctx.audioWorklet.addModule("/playback-worklet.js")
  const worklet = new AudioWorkletNode(ctx, "playback-worklet")
  worklet.connect(ctx.destination)

  const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    socket.binaryType = "arraybuffer"
    socket.addEventListener("open", () => resolve(socket), { once: true })
    socket.addEventListener("error", () => reject(new Error("websocket error")), { once: true })
  })

  ws.addEventListener("message", (e) => {
    if (e.data instanceof ArrayBuffer && e.data.byteLength > 0) {
      const samples = pcmToFloat32(new Uint8Array(e.data))
      worklet.port.postMessage(samples, [samples.buffer])
    }
  })
  ws.addEventListener("close", () => {
    setStatus("session closed")
    session = undefined
    void ctx.close()
  })

  return {
    ws,
    ctx,
    worklet,
    close: async () => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
      await ctx.close()
    },
  }
}

const ensureSession = async (): Promise<Session> => {
  if (session !== undefined && session.ws.readyState === WebSocket.OPEN) return session
  setStatus("connecting…")
  session = await openSession()
  setStatus("streaming · keep typing")
  return session
}

const submit = async (text: string): Promise<void> => {
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  try {
    const s = await ensureSession()
    s.ws.send(JSON.stringify({ text: trimmed }))
    appendHistory(`› ${trimmed}`)
  } catch (err) {
    setStatus(`failed: ${(err as Error).message}`, true)
  }
}

textEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return
  e.preventDefault()
  const value = textEl.value
  textEl.value = ""
  void submit(value)
})
