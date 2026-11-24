/**
 * The audio logic behind the worklets, free of browser APIs so it runs (and is
 * tested) anywhere. Mutable on purpose: `process` runs every 128 samples on the
 * audio thread and must not allocate.
 */

export const MIC_PROCESSOR = "effect-uai-mic"
export const PLAYER_PROCESSOR = "effect-uai-player"

export type MicProcessorOptions = { readonly targetRate: number; readonly frameMs: number }
export type PlayerProcessorOptions = { readonly warmupMs: number }
/** Main thread → player: samples to queue, or a command. */
export type PlayerCommand = Float32Array | { readonly type: "clear" | "reset" }
/** Player → main thread: milliseconds played since the last `clear` or `reset`. */
export type PlayerReport = { readonly played: number }

/**
 * Resamples to `outRate` by averaging each output sample's input window, a
 * box filter that keeps speech free of the aliasing a plain sample pick
 * produces, and hands `emit` 16-bit little-endian frames of `frameMs`.
 */
export const micFramer = (inRate: number, outRate: number, frameMs: number) => {
  const ratio = inRate / outRate
  const out = new Int16Array(Math.max(1, Math.round((outRate * frameMs) / 1000)))
  let n = 0
  let sum = 0
  let count = 0
  let pos = 0
  return (input: Float32Array, emit: (frame: ArrayBuffer) => void): void => {
    for (let i = 0; i < input.length; i++) {
      const sample = input[i]!
      sum += sample
      count++
      pos += 1
      while (pos >= ratio) {
        pos -= ratio
        const v = Math.max(-1, Math.min(1, count > 0 ? sum / count : sample))
        out[n++] = v < 0 ? v * 0x8000 : v * 0x7fff
        if (n === out.length) {
          emit(out.buffer.slice(0))
          n = 0
        }
        sum = 0
        count = 0
      }
    }
  }
}

/**
 * Plays queued chunks in order. Holds `warmup` samples before starting so
 * early jitter is absorbed, starts anyway once that long has passed (so a
 * reply shorter than the warmup still plays), and warms up again after
 * running dry. `pull` returns the samples played since the last `clear` or
 * `reset` when a report is due (every `reportEvery` samples, and on running dry).
 */
export const playbackQueue = (warmup: number, reportEvery: number) => {
  const queue: Array<Float32Array> = []
  let head = 0
  let buffered = 0
  let waited = 0
  let started = false
  let played = 0
  let reported = 0
  return {
    push: (samples: Float32Array): void => {
      queue.push(samples)
      buffered += samples.length
    },
    clear: (): void => {
      queue.length = 0
      head = 0
      buffered = 0
      started = false
      waited = 0
    },
    reset: (): void => {
      played = 0
      reported = 0
    },
    pull: (out: Float32Array): number | undefined => {
      if (!started) {
        if (buffered === 0) return undefined
        waited += out.length
        if (buffered < warmup && waited < warmup) return undefined
        started = true
      }
      let written = 0
      while (written < out.length && queue.length > 0) {
        const chunk = queue[0]!
        const copy = Math.min(chunk.length - head, out.length - written)
        out.set(chunk.subarray(head, head + copy), written)
        written += copy
        head += copy
        if (head >= chunk.length) {
          queue.shift()
          head = 0
        }
      }
      buffered -= written
      played += written
      if (buffered === 0) {
        started = false
        waited = 0
      }
      if (played - reported < reportEvery && buffered > 0) return undefined
      reported = played
      return played
    },
  }
}
