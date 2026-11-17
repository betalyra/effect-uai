/**
 * Raw PCM conversions, for audio that crosses between a provider, a server
 * and a browser. Samples are little-endian and mono-agnostic (interleaved
 * channels pass through sample by sample). Reads go through a `DataView`, so
 * a chunk at any byte offset works.
 */
import { Stream } from "effect"

const S16_MIN = 0x8000
const S16_MAX = 0x7fff

/** 16-bit little-endian PCM to floats in [-1, 1]. A trailing odd byte is ignored. */
export const s16leToF32 = (bytes: Uint8Array): Float32Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(bytes.byteLength >> 1)
  for (let i = 0; i < out.length; i++) {
    const s = view.getInt16(i * 2, true)
    out[i] = s < 0 ? s / S16_MIN : s / S16_MAX
  }
  return out
}

/** Floats to 16-bit little-endian PCM, clamped to [-1, 1]. */
export const f32ToS16le = (samples: Float32Array): Uint8Array => {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(i * 2, v < 0 ? v * S16_MIN : v * S16_MAX, true)
  }
  return out
}

/** 32-bit float little-endian PCM to 16-bit. Trailing bytes short of a sample are ignored. */
export const f32leToS16le = (bytes: Uint8Array): Uint8Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const samples = new Float32Array(bytes.byteLength >> 2)
  for (let i = 0; i < samples.length; i++) samples[i] = view.getFloat32(i * 4, true)
  return f32ToS16le(samples)
}

/**
 * Cut a byte stream on sample boundaries: the bytes short of a whole sample
 * wait for the next chunk instead of being dropped or misread. A partial
 * sample at the very end is dropped.
 */
export const wholeSamples =
  (bytesPerSample: number) =>
  <E, R>(self: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array, E, R> =>
    self.pipe(
      Stream.mapAccum(
        () => new Uint8Array(0),
        (carry, chunk): readonly [Uint8Array, ReadonlyArray<Uint8Array>] => {
          const joined = new Uint8Array(carry.byteLength + chunk.byteLength)
          joined.set(carry)
          joined.set(chunk, carry.byteLength)
          const cut = joined.byteLength - (joined.byteLength % bytesPerSample)
          return [joined.slice(cut), cut === 0 ? [] : [joined.subarray(0, cut)]]
        },
      ),
    )
