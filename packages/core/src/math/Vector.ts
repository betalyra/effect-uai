/**
 * Linear-algebra primitives for `Float32Array` vectors. Used by the
 * embedding-model recipes (cosine similarity for retrieval, normalize
 * for unit-vector indexing) and re-usable for any modality whose feature
 * representation is a dense float32 vector (audio, video, ...).
 *
 * Hot loops are allocation-free; consumers can call these inside
 * `.map()` over thousands of vectors without GC pressure. For
 * GPU / SIMD / WASM-accelerated math at vector-DB scale, reach for a
 * dedicated library - this module deliberately stays at the
 * recipe-volume tier.
 */

/** Inner / dot product. */
export const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!
  return s
}

/** L2 norm (Euclidean magnitude). */
export const l2Norm = (v: Float32Array): number => {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!
  return Math.sqrt(s)
}

/**
 * L2-normalize to a unit vector. Allocates a new `Float32Array`. A zero
 * vector returns zeros (no division-by-zero).
 */
export const normalize = (v: Float32Array): Float32Array => {
  const n = l2Norm(v)
  if (n === 0) return new Float32Array(v.length)
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n
  return out
}

/**
 * Cosine similarity. Range `[-1, 1]`; higher = more similar. Returns
 * `NaN` if either vector has zero magnitude.
 */
export const cosine = (a: Float32Array, b: Float32Array): number => {
  let d = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const ai = a[i]!
    const bi = b[i]!
    d += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Euclidean (L2) distance. */
export const euclidean = (a: Float32Array, b: Float32Array): number => {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!
    s += d * d
  }
  return Math.sqrt(s)
}
