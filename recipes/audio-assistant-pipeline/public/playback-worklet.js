/**
 * Ring-buffered streaming PCM playback. The main thread pushes
 * `Float32Array` chunks via `port.postMessage`; this worklet keeps a
 * FIFO of those chunks and drains them sample-by-sample into the
 * output buffer.
 *
 * A short warmup buffer (~200 ms) is held before playback starts so
 * brief network jitter at the start of generation is absorbed instead
 * of producing audible gaps. Once playback is running, underruns emit
 * silence (zeros) but `started` stays true — subsequent chunks resume
 * exactly where they left off.
 */
const WARMUP_SAMPLES = 0.2 * 48000 // ~200 ms at 48 kHz

class PlaybackWorklet extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []
    this.headOffset = 0
    this.bufferedSamples = 0
    this.started = false
    this.port.onmessage = (e) => {
      if (e.data instanceof Float32Array) {
        this.queue.push(e.data)
        this.bufferedSamples += e.data.length
        if (!this.started && this.bufferedSamples >= WARMUP_SAMPLES) this.started = true
        return
      }
      // Barge-in / cancel: drop everything still buffered so the user hears
      // silence immediately, and re-arm the warmup gate for the next turn.
      if (e.data && e.data.type === "clear") {
        this.queue.length = 0
        this.headOffset = 0
        this.bufferedSamples = 0
        this.started = false
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0]?.[0]
    if (!out || !this.started) return true
    let written = 0
    while (written < out.length && this.queue.length > 0) {
      const head = this.queue[0]
      const available = head.length - this.headOffset
      const need = out.length - written
      const copy = Math.min(available, need)
      out.set(head.subarray(this.headOffset, this.headOffset + copy), written)
      written += copy
      this.headOffset += copy
      if (this.headOffset >= head.length) {
        this.queue.shift()
        this.headOffset = 0
      }
    }
    return true
  }
}

registerProcessor("playback-worklet", PlaybackWorklet)
