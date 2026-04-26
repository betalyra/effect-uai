import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as SSE from "../src/SSE.js"

const enc = new TextEncoder()
const bytesOf = (...chunks: ReadonlyArray<string>) =>
  Stream.fromIterable(chunks.map((c) => enc.encode(c)))

const collect = <A, E>(s: Stream.Stream<A, E>) =>
  Effect.runPromise(Stream.runCollect(s))

describe("SSE.fromBytes", () => {
  it("parses a single complete event", async () => {
    const out = await collect(
      SSE.fromBytes(bytesOf("event: foo\ndata: hello\n\n"))
    )
    expect(out).toEqual([{ event: "foo", data: "hello" }])
  })

  it("joins multiple data lines with \\n", async () => {
    const out = await collect(
      SSE.fromBytes(bytesOf("data: line1\ndata: line2\ndata: line3\n\n"))
    )
    expect(out).toEqual([{ data: "line1\nline2\nline3" }])
  })

  it("handles events split across chunk boundaries", async () => {
    const out = await collect(
      SSE.fromBytes(
        bytesOf("event: split\nda", "ta: hi\n", "\nevent: next\ndata: x\n\n")
      )
    )
    expect(out).toEqual([
      { event: "split", data: "hi" },
      { event: "next", data: "x" }
    ])
  })

  it("handles CRLF line endings", async () => {
    const out = await collect(
      SSE.fromBytes(bytesOf("event: a\r\ndata: b\r\n\r\n"))
    )
    expect(out).toEqual([{ event: "a", data: "b" }])
  })

  it("preserves id and skips comment lines", async () => {
    const out = await collect(
      SSE.fromBytes(bytesOf(": ping\nid: 42\ndata: x\n\n"))
    )
    expect(out).toEqual([{ id: "42", data: "x" }])
  })

  it("flushes a trailing event without a closing blank line", async () => {
    const out = await collect(SSE.fromBytes(bytesOf("data: tail")))
    expect(out).toEqual([{ data: "tail" }])
  })

  it("ignores empty blocks between events", async () => {
    const out = await collect(
      SSE.fromBytes(bytesOf("data: a\n\n\n\ndata: b\n\n"))
    )
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
      { event: "b", id: "7", data: "x" }
    ]
    const reparsed = await collect(
      Stream.fromIterable(events).pipe(SSE.toBytes, SSE.fromBytes)
    )
    expect(reparsed).toEqual(events)
  })
})
