import { Effect, Exit, Filter, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  decodeJsonLines,
  decodeJsonLinesRecoverable,
  fromEffectSchema,
  JsonParseError,
  StructuredDecodeError,
} from "./StructuredFormat.js"

const Item = Schema.Struct({ id: Schema.Number, name: Schema.String })
type Item = typeof Item.Type
const itemFormat = fromEffectSchema(Item, { name: "Item" })

const linesOf = (...xs: ReadonlyArray<string>): Stream.Stream<string> => Stream.fromIterable(xs)

const collect = <A, E>(s: Stream.Stream<A, E>) =>
  Effect.runPromise(Stream.runCollect(s).pipe(Effect.map((c) => Array.from(c))))

describe("decodeJsonLinesRecoverable", () => {
  it("yields a Success for each well-formed line", async () => {
    const out = await collect(
      linesOf('{"id":1,"name":"a"}', '{"id":2,"name":"b"}').pipe(
        decodeJsonLinesRecoverable(itemFormat),
      ),
    )

    expect(out).toHaveLength(2)
    expect(Result.isSuccess(out[0]!)).toBe(true)
    expect(Result.isSuccess(out[1]!)).toBe(true)
    if (Result.isSuccess(out[0]!) && Result.isSuccess(out[1]!)) {
      expect(out[0]!.success).toEqual<Item>({ id: 1, name: "a" })
      expect(out[1]!.success).toEqual<Item>({ id: 2, name: "b" })
    }
  })

  it("yields a Failure for a malformed JSON line WITHOUT aborting the stream", async () => {
    const out = await collect(
      linesOf('{"id":1,"name":"a"}', "not json at all", '{"id":3,"name":"c"}').pipe(
        decodeJsonLinesRecoverable(itemFormat),
      ),
    )

    expect(out).toHaveLength(3)
    expect(Result.isSuccess(out[0]!)).toBe(true)
    expect(Result.isFailure(out[1]!)).toBe(true)
    expect(Result.isSuccess(out[2]!)).toBe(true)
    if (Result.isFailure(out[1]!)) {
      expect(out[1]!.failure).toBeInstanceOf(JsonParseError)
    }
  })

  it("yields a Failure for a schema-invalid line without aborting", async () => {
    const out = await collect(
      linesOf(
        '{"id":1,"name":"a"}',
        '{"id":"not-a-number","name":"b"}', // schema fail
        '{"id":3,"name":"c"}',
      ).pipe(decodeJsonLinesRecoverable(itemFormat)),
    )

    expect(out).toHaveLength(3)
    expect(Result.isSuccess(out[0]!)).toBe(true)
    expect(Result.isFailure(out[1]!)).toBe(true)
    expect(Result.isSuccess(out[2]!)).toBe(true)
    if (Result.isFailure(out[1]!)) {
      expect(out[1]!.failure).toBeInstanceOf(StructuredDecodeError)
    }
  })

  it("propagates upstream errors normally (only DECODE failures are lifted into Result)", async () => {
    const boom = new Error("upstream broke")
    const stream = Stream.concat(linesOf('{"id":1,"name":"a"}'), Stream.fail(boom)).pipe(
      decodeJsonLinesRecoverable(itemFormat),
    )

    const exit = await Effect.runPromise(Effect.exit(Stream.runCollect(stream)))
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it("composes with filter-success / log-and-continue", async () => {
    const out = await collect(
      linesOf('{"id":1,"name":"a"}', "garbage", '{"id":2,"name":"b"}').pipe(
        decodeJsonLinesRecoverable(itemFormat),
        Stream.filterMap(Filter.fromPredicateOption(Result.getSuccess)),
      ),
    )

    expect(out).toEqual<Array<Item>>([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ])
  })
})

describe("decodeJsonLines (fail-fast, sanity)", () => {
  it("aborts the stream on the first bad line", async () => {
    const stream = linesOf('{"id":1,"name":"a"}', "garbage", '{"id":3,"name":"c"}').pipe(
      decodeJsonLines(itemFormat),
    )

    const exit = await Effect.runPromise(Effect.exit(Stream.runCollect(stream)))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
