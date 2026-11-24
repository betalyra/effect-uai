import { describe, expect, it } from "@effect/vitest"
import { micFramer, playbackQueue } from "./audio.js"

const framesOf = (framer: ReturnType<typeof micFramer>, input: Float32Array) => {
  const frames: Array<Int16Array> = []
  framer(input, (frame) => frames.push(new Int16Array(frame)))
  return frames
}

describe("micFramer", () => {
  it("downsamples to the target rate in frames of frameMs", () => {
    // 100 ms at 48 kHz → 1600 samples at 16 kHz → two 50 ms frames of 800.
    const frames = framesOf(micFramer(48000, 16000, 50), new Float32Array(4800).fill(0.5))
    expect(frames.map((f) => f.length)).toEqual([800, 800])
    expect(frames[0]![0]).toBe(Math.trunc(0.5 * 0x7fff))
  })

  it("averages each window and clips to 16 bits", () => {
    const [frame] = framesOf(micFramer(4, 2, 1000), Float32Array.of(1, 0, -2, -2))
    expect(Array.from(frame!)).toEqual([Math.trunc(0.5 * 0x7fff), -0x8000])
  })

  it("keeps a partial frame for the next call", () => {
    const framer = micFramer(16000, 16000, 50)
    expect(framesOf(framer, new Float32Array(500))).toEqual([])
    expect(framesOf(framer, new Float32Array(300)).map((f) => f.length)).toEqual([800])
  })
})

describe("playbackQueue", () => {
  const pull = (queue: ReturnType<typeof playbackQueue>, size: number) => {
    const out = new Float32Array(size)
    return { report: queue.pull(out), out: Array.from(out) }
  }

  it("holds back until the warmup is buffered, then plays chunks in order", () => {
    const queue = playbackQueue(4, 100)
    queue.push(Float32Array.of(1, 2))
    expect(pull(queue, 2)).toEqual({ report: undefined, out: [0, 0] })
    queue.push(Float32Array.of(3, 4))
    expect(pull(queue, 3)).toEqual({ report: undefined, out: [1, 2, 3] })
    // Ran dry: reports what it played and warms up again.
    expect(pull(queue, 3)).toEqual({ report: 4, out: [4, 0, 0] })
    queue.push(Float32Array.of(5))
    expect(pull(queue, 1).report).toBeUndefined()
  })

  it("starts anyway once the warmup time has passed", () => {
    const queue = playbackQueue(4, 100)
    queue.push(Float32Array.of(1))
    expect(pull(queue, 2).report).toBeUndefined()
    expect(pull(queue, 2)).toEqual({ report: 1, out: [1, 0] })
  })

  it("clear drops what is queued; reset restarts the count", () => {
    const queue = playbackQueue(0, 100)
    queue.push(Float32Array.of(1, 2, 3))
    expect(pull(queue, 1).report).toBeUndefined()
    queue.clear()
    queue.reset()
    queue.push(Float32Array.of(9))
    expect(pull(queue, 2)).toEqual({ report: 1, out: [9, 0] })
  })
})
