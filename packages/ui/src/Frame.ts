/**
 * One WebSocket message of a live session. A text message is JSON: an
 * `Envelope` downstream, the app's message upstream. A binary message is
 * media: a big-endian u16 channel, then the payload. Media frames are not
 * sequenced and never stored; `channel-opened` declares their format.
 */
import { Data, Effect, Schema, Stream } from "effect"
import type { Owned } from "./Run.js"
import type { Envelope, StreamId } from "./RunEvent.js"

export type Frame<A> = Data.TaggedEnum<{
  Message: { readonly message: A }
  Media: { readonly channel: number; readonly bytes: Uint8Array }
}>

interface FrameDef extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Frame<this["A"]>
}

/** Constructors, guards and matchers. */
export const Frame = Data.taggedEnum<FrameDef>()

export type Media = Extract<Frame<never>, { readonly _tag: "Media" }>

/** What a WebSocket carries: text or binary. */
export type Wire = string | Uint8Array

/** A message's frame, for `Stream.map`. */
export const message = <A>(message: A): Frame<A> => Frame.Message({ message })

export const media = (channel: number, bytes: Uint8Array): Frame<never> =>
  Frame.Media({ channel, bytes })

export class FrameError extends Data.TaggedError("FrameError")<{ readonly message: string }> {}

const HEADER = 2

/** Encode a frame for the socket; messages through `codec` (e.g. `RunEvent.EnvelopeJson`). */
export const encode = <A, I>(codec: Schema.Codec<A, I>) => {
  const toJson = Schema.encodeEffect(Schema.fromJsonString(codec))
  return (frame: Frame<A>): Effect.Effect<Wire, Schema.SchemaError> =>
    Frame.$match(frame, {
      Message: ({ message }) => toJson(message),
      Media: ({ channel, bytes }) => {
        const out = new Uint8Array(HEADER + bytes.byteLength)
        new DataView(out.buffer).setUint16(0, channel)
        out.set(bytes, HEADER)
        return Effect.succeed(out)
      },
    })
}

const decodeMedia = (bytes: Uint8Array): Effect.Effect<Frame<never>, FrameError> =>
  bytes.byteLength < HEADER
    ? Effect.fail(new FrameError({ message: `media frame of ${bytes.byteLength} bytes` }))
    : Effect.succeed(
        media(
          new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0),
          bytes.subarray(HEADER),
        ),
      )

/** Decode a socket message; text through `codec`, binary as media. */
export const decode = <A, I>(codec: Schema.Codec<A, I>) => {
  const fromJson = Schema.decodeEffect(Schema.fromJsonString(codec))
  return (wire: Wire): Effect.Effect<Frame<A>, Schema.SchemaError | FrameError> =>
    typeof wire === "string" ? Effect.map(fromJson(wire), message) : decodeMedia(wire)
}

/**
 * `Run.sequenceOwned` for a live stream: number the messages, pass media
 * through in place. Tag events with `Run.within` / `Run.streamScoped` first.
 */
export const sequence =
  (streamId: StreamId, options?: { readonly from?: number }) =>
  <E, R>(self: Stream.Stream<Frame<Owned>, E, R>): Stream.Stream<Frame<Envelope>, E, R> =>
    self.pipe(
      Stream.mapAccum(
        () => options?.from ?? 0,
        (seq, frame): readonly [number, ReadonlyArray<Frame<Envelope>>] =>
          Frame.$match(frame, {
            Media: (m) => [seq, [m]] as const,
            Message: ({ message: { runId, event } }) =>
              [
                seq + 1,
                [
                  message<Envelope>(
                    runId === undefined
                      ? { streamId, seq: seq + 1, event }
                      : { streamId, seq: seq + 1, runId, event },
                  ),
                ],
              ] as const,
          }),
      ),
    )
