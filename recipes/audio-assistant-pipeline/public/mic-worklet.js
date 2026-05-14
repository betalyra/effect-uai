/**
 * Mic capture → PCM s16le @ targetRate mono, posted as ~50 ms frames over
 * `port.postMessage`. The browser usually runs the AudioContext at its
 * native rate (44.1 / 48 kHz); we accept the actual `sourceRate` via
 * `processorOptions` and resample to `targetRate` with a simple averaging
 * decimator — good enough for STT.
 */
class MicWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const opts = options?.processorOptions ?? {}
    this.sourceRate = opts.sourceRate ?? sampleRate
    this.targetRate = opts.targetRate ?? 16000
    this.ratio = this.sourceRate / this.targetRate
    this.frameSize = Math.round(this.targetRate * 0.05)
    this.outBuffer = new Int16Array(this.frameSize)
    this.outOffset = 0
    this.acc = 0
  }

  process(inputs) {
    const input = inputs[0]?.[0]
    if (!input) return true
    for (let i = 0; i < input.length; i++) {
      this.acc += 1
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio
        const v = Math.max(-1, Math.min(1, input[i]))
        this.outBuffer[this.outOffset++] = v < 0 ? v * 0x8000 : v * 0x7fff
        if (this.outOffset === this.frameSize) {
          this.port.postMessage(this.outBuffer.buffer.slice(0))
          this.outOffset = 0
        }
      }
    }
    return true
  }
}

registerProcessor("mic-worklet", MicWorklet)
