import { Brand } from "effect"

/**
 * A memory / data size, always represented internally as a number of
 * bytes. Mirrors the `Duration` shape from `effect` — a branded value
 * type with a wider `Input` union for ergonomic construction at call
 * sites.
 *
 * `effect` itself has no byte-count primitive (only `Duration`), so we
 * own this here rather than leak provider-specific shapes (Deno's
 * template-literal `Memory`, Vercel's `mb`, Modal's `gpuMemory`, …)
 * through the cross-provider `Sandbox` request types.
 *
 * @example
 * ```ts
 * import * as Memory from "@effect-uai/core/Memory"
 *
 * Memory.gib(2)                        // 2 GiB → 2_147_483_648 bytes
 * Memory.fromInputUnsafe("1.5 GiB")    // human-string parsing
 * Memory.fromInputUnsafe(1_280_000_000) // raw bytes
 * Memory.toBytes(m)                    // unwrap
 * ```
 */

export type Memory = Brand.Branded<number, "Memory">

const make = Brand.nominal<Memory>()

// ---------------------------------------------------------------------------
// Input — what the public APIs accept.
//
// Supported string forms (case-insensitive on the unit, whitespace
// optional between number and unit):
//
//   "<n>"       bytes (no unit)
//   "<n> B"     bytes
//   "<n> kB"   1_000 bytes      (decimal)
//   "<n> MB"   1_000_000        (decimal)
//   "<n> GB"   1_000_000_000    (decimal)
//   "<n> KiB"  1_024            (binary)
//   "<n> MiB"  1_048_576        (binary)
//   "<n> GiB"  1_073_741_824    (binary)
//
// Decimal vs binary follows the SI / IEC convention (`MB` = 10^6,
// `MiB` = 2^20). When in doubt, prefer the binary `*iB` units.
// ---------------------------------------------------------------------------

export type Input = number | Memory | string

const UNIT_BYTES: Record<string, number> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  tb: 1_000_000_000_000,
  kib: 1_024,
  mib: 1_024 * 1_024,
  gib: 1_024 * 1_024 * 1_024,
  tib: 1_024 * 1_024 * 1_024 * 1_024,
}

const PARSE_RE = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)\s*$/

const parseString = (s: string): number => {
  const m = PARSE_RE.exec(s)
  if (m === null) {
    throw new Error(`Memory: cannot parse "${s}" — expected forms like "1024", "10 MB", "1GiB"`)
  }
  const value = Number(m[1])
  const unit = (m[2] ?? "").toLowerCase()
  if (unit === "") return value
  const factor = UNIT_BYTES[unit]
  if (factor === undefined) {
    throw new Error(
      `Memory: unknown unit "${m[2]}" in "${s}" — supported: ${Object.keys(UNIT_BYTES).join(", ")}`,
    )
  }
  return value * factor
}

/**
 * Coerce a {@link Input} to a {@link Memory}. Throws on malformed
 * strings or non-finite numbers. Mirrors `Duration.fromInputUnsafe`.
 */
export const fromInputUnsafe = (input: Input): Memory => {
  if (typeof input === "number") {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`Memory: bytes must be a non-negative finite number, got ${input}`)
    }
    return make(Math.floor(input))
  }
  return make(Math.floor(parseString(input)))
}

// ---------------------------------------------------------------------------
// Unwrap
// ---------------------------------------------------------------------------

/** Return the underlying byte count. */
export const toBytes = (m: Memory | Input): number =>
  typeof m === "number" && (m as number) === Math.floor(m as number) && (m as number) >= 0
    ? (m as number)
    : (fromInputUnsafe(m) as unknown as number)

// ---------------------------------------------------------------------------
// Unit constructors — terse for use at call sites.
// ---------------------------------------------------------------------------

/** N bytes. */
export const bytes = (n: number): Memory => make(Math.floor(n))

/** N KiB (binary kibibytes, `n * 1024`). */
export const kib = (n: number): Memory => make(Math.floor(n * 1_024))

/** N MiB (binary mebibytes, `n * 1024^2`). */
export const mib = (n: number): Memory => make(Math.floor(n * 1_024 * 1_024))

/** N GiB (binary gibibytes, `n * 1024^3`). */
export const gib = (n: number): Memory => make(Math.floor(n * 1_024 * 1_024 * 1_024))

/** N kB (decimal kilobytes, `n * 1000`). */
export const kb = (n: number): Memory => make(Math.floor(n * 1_000))

/** N MB (decimal megabytes, `n * 1_000_000`). */
export const mb = (n: number): Memory => make(Math.floor(n * 1_000_000))

/** N GB (decimal gigabytes, `n * 1_000_000_000`). */
export const gb = (n: number): Memory => make(Math.floor(n * 1_000_000_000))
