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

const toS16 = (sample: number): number => {
  const v = Math.max(-1, Math.min(1, sample))
  return v < 0 ? v * S16_MIN : v * S16_MAX
}

/** Floats to 16-bit little-endian PCM, clamped to [-1, 1]. */
export const f32ToS16le = (samples: Float32Array): Uint8Array => {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, toS16(samples[i] ?? 0), true)
  return out
}

/** 32-bit float little-endian PCM to 16-bit. Trailing bytes short of a sample are ignored. */
export const f32leToS16le = (bytes: Uint8Array): Uint8Array => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Uint8Array((bytes.byteLength >> 2) * 2)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < out.length >> 1; i++) {
    outView.setInt16(i * 2, toS16(view.getFloat32(i * 4, true)), true)
  }
  return out
}

/**
 * Split `carry` + `chunk` on a sample boundary into `[rest, whole]`: `rest` is
 * the bytes short of a whole sample, to carry into the next call. Copies only
 * when something is carried; `whole` may share the chunk's buffer.
 */
export const splitSamples =
  (bytesPerSample: number) =>
  (carry: Uint8Array, chunk: Uint8Array): readonly [rest: Uint8Array, whole: Uint8Array] => {
    const joined = carry.byteLength === 0 ? chunk : concat(carry, chunk)
    const cut = joined.byteLength - (joined.byteLength % bytesPerSample)
    return [joined.slice(cut), joined.subarray(0, cut)]
  }

const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(a.byteLength + b.byteLength)
  out.set(a)
  out.set(b, a.byteLength)
  return out
}

/**
 * Cut a byte stream on sample boundaries: the bytes short of a whole sample
 * wait for the next chunk instead of being dropped or misread. A partial
 * sample at the very end is dropped.
 */
export const wholeSamples = (bytesPerSample: number) => {
  const split = splitSamples(bytesPerSample)
  return <E, R>(self: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array, E, R> =>
    self.pipe(
      Stream.mapAccum(
        () => new Uint8Array(0),
        (carry, chunk): readonly [Uint8Array, ReadonlyArray<Uint8Array>] => {
          const [rest, whole] = split(carry, chunk)
          return [rest, whole.byteLength === 0 ? [] : [whole]]
        },
      ),
    )
}
