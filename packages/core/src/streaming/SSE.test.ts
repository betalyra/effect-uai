import { Cause, Deferred, Effect, Exit, Fiber, Result, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as SSE from "./SSE.js"

const enc = new TextEncoder()
const bytesOf = (...chunks: ReadonlyArray<string>) =>
  Stream.fromIterable(chunks.map((c) => enc.encode(c)))

const collect = <A, E>(s: Stream.Stream<A, E>) => Effect.runPromise(Stream.runCollect(s))

const runUntilEnd = <A, E>(s: Stream.Stream<A, E>) =>
  Effect.runPromise(
    s.pipe(
      Stream.result,
      Stream.runCollect,
      Effect.map((results) => ({
        seen: results.filter(Result.isSuccess).map((r) => r.success),
        failures: results.filter(Result.isFailure).map((r) => r.failure),
      })),
    ),
  )

const failuresOf = (exit: Exit.Exit<unknown, unknown>): ReadonlyArray<unknown> =>
  Exit.isFailure(exit) ? exit.cause.reasons.filter(Cause.isFailReason).map((r) => r.error) : []

describe("SSE.fromBytes", () => {
  it("parses a single complete event", async () => {
    const out = await collect(SSE.fromBytes(bytesOf("event: foo\ndata: hello\n\n")))
    expect(out).toEqual([{ event: "foo", data: "hello" }])
  })

  it("joins multiple data lines with \\n", async () => {
    const out = await collect(SSE.fromBytes(bytesOf("data: line1\ndata: line2\ndata: line3\n\n")))
    expect(out).toEqual([{ data: "line1\nline2\nline3" }])
  })

  it("handles events split across chunk boundaries", async () => {
    const out = await collect(
      SSE.fromBytes(bytesOf("event: split\nda", "ta: hi\n", "\nevent: next\ndata: x\n\n")),
    )
    expect(out).toEqual([
      { event: "split", data: "hi" },
      { event: "next", data: "x" },
    ])
  })

  it("handles CRLF line endings", async () => {
    const out = await collect(SSE.fromBytes(bytesOf("event: a\r\ndata: b\r\n\r\n")))
    expect(out).toEqual([{ event: "a", data: "b" }])
  })

  it("preserves id and skips comment lines", async () => {
    const out = await collect(SSE.fromBytes(bytesOf(": ping\nid: 42\ndata: x\n\n")))
    expect(out).toEqual([{ id: "42", data: "x" }])
  })

  it("parses a data field with no space after the colon", async () => {
    const out = await collect(SSE.fromBytes(bytesOf("data:x\n\n")))
    expect(out).toEqual([{ data: "x" }])
  })

  it("ignores an id containing a NUL character", async () => {
    const out = await collect(SSE.fromBytes(bytesOf("id: a\u0000b\ndata: x\n\n")))
    expect(out).toEqual([{ data: "x" }])
  })

  it("discards a trailing event without a closing blank line", async () => {
    const out = await collect(SSE.fromBytes(bytesOf("data: tail")))
    expect(out).toEqual([])
  })

  it("discards buffered partial data when the upstream fails mid-stream", async () => {
    const failing = Stream.concat(
      bytesOf("data: good\n\ndata: partial-tr"),
      Stream.fail("boom" as const),
    )
    const { seen, failures } = await runUntilEnd(SSE.fromBytes(failing))
    expect(seen).toEqual([{ data: "good" }])
    expect(failures).toEqual(["boom"])
  })

  it("discards a partial multi-byte char in the text decoder when the upstream fails", async () => {
    const partialSquid = enc.encode("data: 🦑\n\n").slice(0, 8)
    const failing = Stream.concat(
      Stream.fromIterable([enc.encode("data: ok\n\n"), partialSquid]),
      Stream.fail("boom" as const),
    )
    const { seen, failures } = await runUntilEnd(SSE.fromBytes(failing))
    expect(seen).toEqual([{ data: "ok" }])
    expect(failures).toEqual(["boom"])
  })

  it("discards buffered partial data when the stream is interrupted", async () => {
    const { seen, exit } = await Effect.runPromise(
      Effect.gen(function* () {
        const seen: Array<SSE.Event> = []
        const latch = yield* Deferred.make<void>()
        const hanging = Stream.concat(bytesOf("data: good\n\ndata: partial"), Stream.never)
        const fiber = yield* Stream.runForEach(SSE.fromBytes(hanging), (e) =>
          Effect.sync(() => {
            seen.push(e)
          }).pipe(Effect.andThen(Deferred.succeed(latch, void 0))),
        ).pipe(Effect.forkChild)
        yield* Deferred.await(latch)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        return { seen, exit }
      }),
    )
    expect(seen).toEqual([{ data: "good" }])
    expect(Exit.isFailure(exit)).toBe(true)
    expect(failuresOf(exit)).toEqual([])
  })

  it("ignores retry directives", async () => {
    const out = await collect(SSE.fromBytes(bytesOf("retry: 3000\n\ndata: a\n\n")))
    expect(out).toEqual([{ data: "a" }])
  })

  it("treats an explicit 'event: message' as the default event", async () => {
    const out = await collect(SSE.fromBytes(bytesOf("event: message\ndata: x\n\n")))
    expect(out).toEqual([{ data: "x" }])
  })

  it("does not dispatch events with no data", async () => {
    const out = await collect(SSE.fromBytes(bytesOf("event: ping\n\ndata: x\n\n")))
    expect(out).toEqual([{ data: "x" }])
  })

  it("ignores empty blocks between events", async () => {
    const out = await collect(SSE.fromBytes(bytesOf("data: a\n\n\n\ndata: b\n\n")))
    expect(out).toEqual([{ data: "a" }, { data: "b" }])
  })

  it("handles a UTF-8 multi-byte char split across chunks", async () => {
    // "🦑" is 0xF0 0x9F 0xA6 0x91. Split between bytes 2 and 3.
    const squidBytes = enc.encode("data: 🦑\n\n")
    const a = squidBytes.slice(0, 8) // "data: " + first 2 bytes of squid
    const b = squidBytes.slice(8) // remaining squid bytes + "\n\n"
    const out = await collect(SSE.fromBytes(Stream.fromIterable([a, b])))
    expect(out).toEqual([{ data: "🦑" }])
  })
})

describe("SSE.toBytes round-trip", () => {
  it("re-parses what it serializes", async () => {
    const events: ReadonlyArray<SSE.Event> = [
      { event: "a", data: "hello" },
      { data: "multi\nline" },
      { event: "b", id: "7", data: "x" },
    ]
    const reparsed = await collect(Stream.fromIterable(events).pipe(SSE.toBytes, SSE.fromBytes))
    expect(reparsed).toEqual(events)
  })
})
