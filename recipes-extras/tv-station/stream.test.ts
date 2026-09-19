/**
 * The broadcast's one promise: whatever goes in, stills or clips from
 * anywhere, one codec configuration comes out, and the two tracks end
 * together. A progressive MP4 states each track's configuration once,
 * so the first time this fails a browser stops decoding mid-stream.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { Array as Arr, Effect, Fiber, Stream } from "effect"
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSource,
  BufferSource,
  BufferTarget,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSample,
  VideoSampleSource,
} from "mediabunny"
import { broadcast, registerCodecs } from "./stream.js"

/** Nothing like the house format: 640x360 at 30fps, mono sound at 44.1kHz. */
const FOREIGN = { width: 640, height: 360, frameRate: 30, sampleRate: 44100, seconds: 2 }

/** A frame of flat grey that changes shade, so the encoder has to work. */
const shade = (index: number): VideoSample => {
  const luma = FOREIGN.width * FOREIGN.height
  const data = new Uint8Array(luma + luma / 2)
  data.fill(16 + ((index * 7) % 200), 0, luma)
  data.fill(128, luma)
  return new VideoSample(data, {
    format: "I420",
    codedWidth: FOREIGN.width,
    codedHeight: FOREIGN.height,
    timestamp: index / FOREIGN.frameRate,
    duration: 1 / FOREIGN.frameRate,
  })
}

const tone = (): AudioSample => {
  const count = FOREIGN.sampleRate * FOREIGN.seconds
  const data = Float32Array.from(
    { length: count },
    (_, i) => Math.sin((2 * Math.PI * 440 * i) / FOREIGN.sampleRate) * 0.2,
  )
  return new AudioSample({
    data,
    format: "f32",
    numberOfChannels: 1,
    sampleRate: FOREIGN.sampleRate,
    timestamp: 0,
  })
}

/** A clip as a provider might have sent it, written the ordinary way. */
const foreignClip: Effect.Effect<Uint8Array> = Effect.gen(function* () {
  const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const video = new VideoSampleSource({ codec: "avc", bitrate: 500_000 })
  const audio = new AudioSampleSource({ codec: "aac", bitrate: 64_000 })
  output.addVideoTrack(video, { frameRate: FOREIGN.frameRate })
  output.addAudioTrack(audio)
  yield* Effect.promise(() => output.start())
  yield* Effect.forEach(
    Arr.range(0, FOREIGN.frameRate * FOREIGN.seconds - 1),
    (index) =>
      Effect.acquireUseRelease(
        Effect.sync(() => shade(index)),
        (frame) => Effect.promise(() => video.add(frame)),
        (frame) => Effect.sync(() => frame.close()),
      ),
    { discard: true },
  )
  yield* Effect.acquireUseRelease(
    Effect.sync(tone),
    (sound) => Effect.promise(() => audio.add(sound)),
    (sound) => Effect.sync(() => sound.close()),
  )
  yield* Effect.promise(() => output.finalize())
  return new Uint8Array((output.target as BufferTarget).buffer!)
})

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"])

/** Sample-description entry counts, one per track, read straight off the boxes. */
const sampleDescriptions = (
  bytes: Uint8Array,
  at = 0,
  end = bytes.byteLength,
): ReadonlyArray<number> => {
  if (at + 8 > end) return []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const size = view.getUint32(at) || end - at
  const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
  const rest = sampleDescriptions(bytes, at + size, end)
  if (type === "stsd") return [view.getUint32(at + 12), ...rest]
  if (CONTAINERS.has(type)) return [...sampleDescriptions(bytes, at + 8, at + size), ...rest]
  return rest
}

const joined = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  chunks.reduce((pos, c) => {
    out.set(c, pos)
    return pos + c.length
  }, 0)
  return out
}

describe("broadcast", () => {
  it("airs stills and a foreign clip under one codec configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-station-"))
    const clip = join(dir, "clip.mp4")
    writeFileSync(clip, await Effect.runPromise(Effect.andThen(registerCodecs, foreignClip)))

    const { bytes, length, rest } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const cast = yield* broadcast
          const body = yield* Effect.forkChild(
            Stream.runFold(
              cast.tap(0),
              () => [] as ReadonlyArray<Uint8Array>,
              (all, chunk) => [...all, chunk],
            ),
          )
          yield* cast.hold(1)
          const length = yield* cast.append(clip)
          // Long enough that the encoder's lookahead has let the clip through.
          yield* cast.hold(3)
          yield* cast.close
          const bytes = joined(yield* Fiber.join(body))
          // A browser that comes back asks for the rest by byte range.
          const rest = yield* Stream.runFold(
            cast.tap(4096),
            () => [] as ReadonlyArray<Uint8Array>,
            (all, chunk) => [...all, chunk],
          )
          return { bytes, length, rest: joined(rest) }
        }),
      ),
    )

    expect(length).toBeCloseTo(FOREIGN.seconds, 1)
    expect(sampleDescriptions(bytes)).toEqual([1, 1])
    expect(rest).toEqual(bytes.subarray(4096))

    const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) })
    const video = await input.getPrimaryVideoTrack()
    const audio = await input.getPrimaryAudioTrack()
    expect(video?.codedWidth).toBe(1280)
    expect(video?.codedHeight).toBe(720)
    expect(audio?.sampleRate).toBe(48000)
    expect(audio?.numberOfChannels).toBe(2)

    // Closing discards what the encoder still held, so the tail is short
    // of the 5s aired; what matters is that both tracks stop together.
    const [seen, heard] = await Promise.all([video!.computeDuration(), audio!.computeDuration()])
    expect(seen).toBeGreaterThan(4)
    expect(Math.abs(seen - heard)).toBeLessThan(0.1)
    input.dispose()
  }, 60_000)
})
