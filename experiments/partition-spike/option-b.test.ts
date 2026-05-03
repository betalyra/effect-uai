import { Array as Arr, Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { executePartitioned } from "./option-b.js"
import { cancelled, denied, isDenied, parseFailure } from "./tool-outcome.js"

const fc = (call_id: string, name: string, args: unknown): Items.FunctionCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: JSON.stringify(args),
})

// ---------------------------------------------------------------------------
// Tool fixtures
// ---------------------------------------------------------------------------

const SafeInput = Schema.Struct({ q: Schema.String })
const safeRead = Tool.make({
  name: "read_thing",
  description: "Read.",
  inputSchema: Tool.fromEffectSchema(SafeInput),
  run: ({ q }) => Effect.succeed({ q, ok: true }),
  strict: true,
})

const SensitiveInput = Schema.Struct({ target: Schema.String })
const dangerous = Tool.make({
  name: "do_dangerous",
  description: "Boom.",
  inputSchema: Tool.fromEffectSchema(SensitiveInput),
  run: ({ target }) => Effect.succeed({ target, did: "the thing" }),
  strict: true,
})

const toolkit = Toolkit.make([safeRead, dangerous])

// ---------------------------------------------------------------------------
// Sanity check: Arr.partition behaves the way we wire it up in
// executePartitioned (Result.fail → safe, Result.succeed → gated).
// ---------------------------------------------------------------------------

describe("Arr.partition (used directly inside executePartitioned)", () => {
  it("routes Result.fail to the left tuple element and Result.succeed to the right", () => {
    const calls = [
      fc("a", "read_thing", { q: "x" }),
      fc("b", "do_dangerous", { target: "y" }),
      fc("c", "read_thing", { q: "z" }),
    ]
    const isSensitive = (c: Items.FunctionCall) => c.name === "do_dangerous"
    const [safe, gated] = Arr.partition(calls, (c) =>
      isSensitive(c) ? Result.succeed(c) : Result.fail(c),
    )
    expect(safe.map((c) => c.call_id)).toEqual(["a", "c"])
    expect(gated.map((c) => c.call_id)).toEqual(["b"])
  })
})

// ---------------------------------------------------------------------------
// Outcome constructors and parser
// ---------------------------------------------------------------------------

describe("denied / cancelled", () => {
  it("produce FunctionCallOutputs whose JSON parses back through ToolFailure schema", () => {
    const call = fc("c1", "do_dangerous", { target: "x" })
    const denialOut = denied(call, "Out of scope.")
    expect(denialOut.call_id).toBe("c1")

    const denialFailure = parseFailure(denialOut)
    expect(denialFailure).not.toBeNull()
    expect(isDenied(denialFailure!)).toBe(true)
    expect(denialFailure).toEqual({ kind: "denied", reason: "Out of scope." })

    const cancelOut = cancelled(call, "Timed out.")
    const cancelFailure = parseFailure(cancelOut)
    expect(cancelFailure).toEqual({ kind: "cancelled", reason: "Timed out." })
  })

  it("uses default reasons when none provided", () => {
    const call = fc("c1", "do_dangerous", { target: "x" })
    expect(parseFailure(denied(call))?.kind).toBe("denied")
    expect(parseFailure(cancelled(call))?.kind).toBe("cancelled")
  })

  it("parseFailure returns null for normal successful tool outputs", () => {
    const successOut = Items.functionCallOutput(
      "c1",
      JSON.stringify({ results: ["one", "two"] }),
    )
    expect(parseFailure(successOut)).toBeNull()
  })

  it("parseFailure returns null for malformed JSON without throwing", () => {
    const garbled = Items.functionCallOutput("c1", "not even json {{{")
    expect(parseFailure(garbled)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// executePartitioned
// ---------------------------------------------------------------------------

describe("executePartitioned", () => {
  it("runs safe via executeAllSafe by default; routes gated to onGated", async () => {
    const calls = [
      fc("a", "read_thing", { q: "alpha" }),
      fc("b", "do_dangerous", { target: "beta" }),
      fc("c", "read_thing", { q: "gamma" }),
    ]

    const onGated = (gated: ReadonlyArray<Items.FunctionCall>) =>
      Effect.succeed(gated.map((c) => denied(c, "no thanks")))

    const outputs = await Effect.runPromise(
      executePartitioned(toolkit, calls, {
        predicate: (c) => c.name === "do_dangerous",
        onGated,
      }),
    )

    // Two safe outputs (executed) + one gated output (denied), order
    // [...safe, ...gated]:
    expect(outputs.map((o) => o.call_id)).toEqual(["a", "c", "b"])

    expect(JSON.parse(outputs[0]!.output)).toMatchObject({ q: "alpha", ok: true })
    expect(JSON.parse(outputs[1]!.output)).toMatchObject({ q: "gamma", ok: true })
    expect(parseFailure(outputs[2]!)).toMatchObject({ kind: "denied" })
  })

  it("invokes onGated even with an empty list - the user's effect handles its own no-op case", async () => {
    let invokedWith: ReadonlyArray<Items.FunctionCall> | undefined
    const calls = [fc("a", "read_thing", { q: "x" })]

    const outputs = await Effect.runPromise(
      executePartitioned(toolkit, calls, {
        predicate: () => false,
        onGated: (gated) => {
          invokedWith = gated
          return Effect.succeed(gated.map((c) => denied(c)))
        },
      }),
    )

    // onGated WAS invoked, with []. Cleaner than special-casing inside
    // the primitive - users do `if (gated.length === 0) return Effect.succeed([])`
    // when they want the short-circuit, or just let the natural identities
    // (Effect.forEach over [] returns []) handle it.
    expect(invokedWith).toEqual([])
    expect(outputs).toHaveLength(1)
  })

  it("invokes onSafe (or default) even with an empty list, same reasoning", async () => {
    let safeRanWith: ReadonlyArray<Items.FunctionCall> | undefined
    const calls = [fc("b", "do_dangerous", { target: "x" })]

    const outputs = await Effect.runPromise(
      executePartitioned(toolkit, calls, {
        predicate: () => true,
        onGated: (gated) => Effect.succeed(gated.map((c) => denied(c))),
        onSafe: (_tk, safe) => {
          safeRanWith = safe
          return Effect.succeed(safe.map((c) => Items.functionCallOutput(c.call_id, "ran")))
        },
      }),
    )

    expect(safeRanWith).toEqual([])
    expect(outputs).toHaveLength(1)
    expect(parseFailure(outputs[0]!)?.kind).toBe("denied")
  })

  it("runs safe and gated concurrently (gated parking does not stall safe)", async () => {
    const calls = [
      fc("a", "read_thing", { q: "x" }),
      fc("b", "do_dangerous", { target: "y" }),
    ]

    const safeStartedAt = { value: 0 }
    const gatedStartedAt = { value: 0 }

    const customSafe = (
      _tk: typeof toolkit,
      safe: ReadonlyArray<Items.FunctionCall>,
    ): Effect.Effect<ReadonlyArray<Items.FunctionCallOutput>> =>
      Effect.gen(function* () {
        safeStartedAt.value = Date.now()
        return safe.map((c) => Items.functionCallOutput(c.call_id, JSON.stringify({ ok: true })))
      })

    const onGated = (gated: ReadonlyArray<Items.FunctionCall>) =>
      Effect.gen(function* () {
        gatedStartedAt.value = Date.now()
        // Simulate the verdict wait. Safe must not be blocked behind this.
        yield* Effect.sleep("50 millis")
        return gated.map((c) => denied(c))
      })

    const start = Date.now()
    const outputs = await Effect.runPromise(
      executePartitioned(toolkit, calls, {
        predicate: (c) => c.name === "do_dangerous",
        onGated,
        onSafe: customSafe,
      }),
    )
    const total = Date.now() - start

    // Both should have started within a few ms of `start`. Safe must
    // complete well before the 50ms gated sleep.
    expect(safeStartedAt.value - start).toBeLessThan(20)
    expect(gatedStartedAt.value - start).toBeLessThan(20)
    expect(outputs).toHaveLength(2)
    // Total run time bounded by the slower path, not their sum.
    expect(total).toBeLessThan(100)
  })
})
