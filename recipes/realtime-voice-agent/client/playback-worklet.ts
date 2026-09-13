/// <reference path="./worklet.d.ts" />
/**
 * Ring-buffered streaming PCM playback. The main thread pushes
 * `Float32Array` chunks via `port.postMessage`; this worklet keeps a FIFO of
 * those chunks and drains them into the output buffer.
 *
 * A short warmup (~200 ms of the context's own rate, not a hard-coded 48 kHz)
 * is held before playback starts, so early jitter is absorbed rather than
 * heard as a gap. Once running, an underrun emits silence but playback stays
 * started, so the next chunk resumes where it left off.
 *
 * It also reports how much it has truly played. The model generates faster
 * than real time, so this is the only place that knows how much of an answer
 * was actually heard.
 */
const WARMUP_SECONDS = 0.2
const REPORT_EVERY_SECONDS = 0.1

class PlaybackWorklet extends AudioWorkletProcessor {
  private queue: Float32Array[] = []
  private headOffset = 0
  private bufferedSamples = 0
  private started = false
  private playedSamples = 0
  private lastReported = 0
  private readonly warmupSamples = WARMUP_SECONDS * sampleRate
  private readonly reportEvery = REPORT_EVERY_SECONDS * sampleRate

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data instanceof Float32Array) {
        this.queue.push(e.data)
        this.bufferedSamples += e.data.length
        if (!this.started && this.bufferedSamples >= this.warmupSamples) this.started = true
        return
      }
      // Barge-in: drop everything buffered so the voice stops at once, and
      // re-arm the warmup gate for the next answer.
      if (e.data && e.data.type === "clear") {
        this.queue.length = 0
        this.headOffset = 0
        this.bufferedSamples = 0
        this.started = false
      }
      // The position is reported against one assistant item, so each answer
      // counts from zero.
      if (e.data && (e.data.type === "clear" || e.data.type === "reset")) {
        this.playedSamples = 0
        this.lastReported = 0
      }
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]?.[0]
    if (!out || !this.started) return true
    let written = 0
    while (written < out.length && this.queue.length > 0) {
      const head = this.queue[0]!
      const available = head.length - this.headOffset
      const copy = Math.min(available, out.length - written)
      out.set(head.subarray(this.headOffset, this.headOffset + copy), written)
      written += copy
      this.headOffset += copy
      if (this.headOffset >= head.length) {
        this.queue.shift()
        this.headOffset = 0
      }
    }
    this.playedSamples += written
    if (this.playedSamples - this.lastReported >= this.reportEvery) {
      this.lastReported = this.playedSamples
      this.port.postMessage({ type: "played", ms: (this.playedSamples / sampleRate) * 1000 })
    }
    return true
  }
}

registerProcessor("playback-worklet", PlaybackWorklet)
