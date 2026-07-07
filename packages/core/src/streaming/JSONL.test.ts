import { Effect, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as JSONL from "./JSONL.js"

const enc = new TextEncoder()
const bytesOf = (...chunks: ReadonlyArray<string>) =>
  Stream.fromIterable(chunks.map((c) => enc.encode(c)))

const collect = <A, E>(s: Stream.Stream<A, E>) => Effect.runPromise(Stream.runCollect(s))

const runUntilEnd = <A, E>(s: Stream.Stream<A, E>) =>
  Effect.runPromise(
    s.pipe(
      Stream.map((a): Result.Result<A, E> => Result.succeed(a)),
      Stream.catch((e) => Stream.succeed<Result.Result<A, E>>(Result.fail(e))),
      Stream.runCollect,
      Effect.map((results) => ({
        seen: results.filter(Result.isSuccess).map((r) => r.success),
        failures: results.filter(Result.isFailure).map((r) => r.failure),
      })),
    ),
  )

const collectResult = <A, E>(s: Stream.Stream<A, E>) =>
  Effect.runPromise(Effect.result(Stream.runCollect(s)))

const Patch = Schema.Struct({ op: Schema.String, value: Schema.Number })

describe("JSONL.fromBytes", () => {
  it("emits one string per line", async () => {
    const out = await collect(JSONL.fromBytes(bytesOf("a\nb\nc\n")))
    expect(out).toEqual(["a", "b", "c"])
  })

  it("buffers lines across chunk boundaries", async () => {
    const out = await collect(JSONL.fromBytes(bytesOf("ab", "c\nde", "f\n")))
    expect(out).toEqual(["abc", "def"])
  })

  it("flushes a trailing line without a final newline", async () => {
    const out = await collect(JSONL.fromBytes(bytesOf("a\nb")))
    expect(out).toEqual(["a", "b"])
  })

  it("ignores blank lines", async () => {
    const out = await collect(JSONL.fromBytes(bytesOf("a\n\n\nb\n")))
    expect(out).toEqual(["a", "b"])
  })

  it("discards a buffered partial line when the upstream fails mid-stream", async () => {
    const failing = Stream.concat(bytesOf('{"n":1}\n{"n":2'), Stream.fail("boom" as const))
    const { seen, failures } = await runUntilEnd(JSONL.fromBytes(failing))
    expect(seen).toEqual(['{"n":1}'])
    expect(failures).toEqual(["boom"])
  })
})

describe("JSONL.parse", () => {
  it("decodes well-formed JSON lines through a Schema", async () => {
    const out = await collect(
      bytesOf(`{"op":"add","value":1}\n{"op":"sub","value":2}\n`).pipe(
        JSONL.fromBytes,
        JSONL.parse(Patch),
      ),
    )
    expect(out).toEqual([
      { op: "add", value: 1 },
      { op: "sub", value: 2 },
    ])
  })

  it("fails with JsonParseError on malformed JSON", async () => {
    const result = await collectResult(
      bytesOf(`{"op":"add","value":1}\nNOT_JSON\n`).pipe(JSONL.fromBytes, JSONL.parse(Patch)),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("JsonParseError")
      expect(result.failure.line).toBe("NOT_JSON")
    }
  })

  it("fails with JsonParseError on schema mismatch", async () => {
    const result = await collectResult(
      bytesOf(`{"op":"add","value":"not a number"}\n`).pipe(JSONL.fromBytes, JSONL.parse(Patch)),
    )
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("JsonParseError")
    }
  })
})

describe("JSONL round-trip", () => {
  it("toBytes then fromBytes/parse recovers the values", async () => {
    const values = [
      { op: "a", value: 1 },
      { op: "b", value: 2 },
    ]
    const out = await collect(
      Stream.fromIterable(values).pipe(JSONL.toBytes(Patch), JSONL.fromBytes, JSONL.parse(Patch)),
    )
    expect(out).toEqual(values)
  })
})
