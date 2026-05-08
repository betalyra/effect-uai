/**
 * Linear-algebra primitives for embedding vectors:
 *
 * - **Dense float32**: `dot`, `l2Norm`, `normalize`, `cosine`,
 *   `euclidean`. Used for retrieval over single-vector embeddings.
 * - **Sparse**: `sparseDot`, `sparseL2Norm`, `sparseCosine`. Used with
 *   `SparseEmbedding`, e.g. Jina ELSER outputs.
 * - **Multivector** (late-interaction): `maxSim`. Used with
 *   `MultivectorEmbedding`, e.g. Jina v4 multivector / ColBERT.
 *
 * Hot loops are allocation-free; consumers can call these inside
 * `.map()` over thousands of vectors without GC pressure. For
 * GPU / SIMD / WASM-accelerated math at vector-DB scale, reach for a
 * dedicated library - this module deliberately stays at the
 * recipe-volume tier.
 */
import type { MultivectorEmbedding, SparseEmbedding } from "../embedding-model/Embedding.js"

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

// ---------------------------------------------------------------------------
// Sparse vectors (Record<string, number>)
// ---------------------------------------------------------------------------

/** Inner product over the intersection of token keys. */
export const sparseDot = (a: SparseEmbedding, b: SparseEmbedding): number => {
  // Iterate the smaller map; lookup against the larger one. O(min(|a|, |b|)).
  const aSize = Object.keys(a.weights).length
  const bSize = Object.keys(b.weights).length
  const [smaller, larger] = aSize <= bSize ? [a.weights, b.weights] : [b.weights, a.weights]
  let s = 0
  for (const token in smaller) {
    const other = larger[token]
    if (other !== undefined) s += smaller[token]! * other
  }
  return s
}

/** L2 norm of a sparse vector. */
export const sparseL2Norm = (v: SparseEmbedding): number => {
  let s = 0
  for (const token in v.weights) {
    const w = v.weights[token]!
    s += w * w
  }
  return Math.sqrt(s)
}

/**
 * Sparse cosine similarity. Range `[-1, 1]` (typically `[0, 1]` for
 * learned-sparse encoders since weights are non-negative). Returns
 * `NaN` if either vector has zero magnitude.
 */
export const sparseCosine = (a: SparseEmbedding, b: SparseEmbedding): number =>
  sparseDot(a, b) / (sparseL2Norm(a) * sparseL2Norm(b))

// ---------------------------------------------------------------------------
// Multivector / late-interaction (ColBERT-style)
// ---------------------------------------------------------------------------

/**
 * MaxSim score for late-interaction retrieval. For each *query* vector,
 * find the maximum dot product with any *document* vector, then sum.
 *
 * Captures fine-grained relevance that single-vector cosine smears out:
 * each query token finds its own best-matching document token.
 *
 * Cost: O(|q| × |d| × dim). Fine at recipe volume; for production-scale
 * retrieval use a vector store with native multivector indexing
 * (Vespa, Qdrant, PLAID).
 */
export const maxSim = (q: MultivectorEmbedding, d: MultivectorEmbedding): number => {
  let total = 0
  for (const qv of q.vectors) {
    let best = -Infinity
    for (const dv of d.vectors) {
      const s = dot(qv, dv)
      if (s > best) best = s
    }
    total += best
  }
  return total
}
