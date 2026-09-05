/**
 * One picture, changed by conversation. You say what to change, the model
 * redraws, you say the next thing.
 *
 *   first request  → generate
 *   every one after → edit, conditioned on the anchor and the last frame
 *
 * The anchor is the first image and it is never dropped. Editing the
 * previous image alone is a copy of a copy, and the artifacts compound
 * (arxiv 2606.11751); keeping the original attached is what stops that,
 * and it costs one array entry.
 *
 * Runtime-agnostic: the generic `ImageGenerator` tag and a `Stream` of
 * requests, so the terminal lives in `app.ts` and a test can drive this
 * with `Stream.fromIterable`.
 */
import { Clock, Data, Effect, Option, Ref, Stream } from "effect"
import { Array as Arr } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import type { ImageSource } from "@effect-uai/core/Image"
import { type ImageStreamEvent, isPartialImage } from "@effect-uai/core/ImageGenerator"

/**
 * How one image gets drawn, given the prompt and whatever it should be
 * conditioned on. A parameter rather than a call, because previews are a
 * capability not every provider has: a renderer that streams emits
 * previews then a `Complete`, one that cannot emits only the `Complete`,
 * and the session cannot tell the difference.
 */
export type Draw<R> = (
  prompt: string,
  references: ReadonlyArray<ImageSource>,
) => Stream.Stream<ImageStreamEvent, AiError.AiError, R>

export type SessionEvent = Data.TaggedEnum<{
  Started: { readonly turn: number; readonly request: string }
  /** A preview of the image being drawn. Cheap to show, safe to drop. */
  Preview: { readonly turn: number; readonly index: number; readonly image: ImageSource }
  Ready: { readonly turn: number; readonly image: ImageSource; readonly millis: number }
}>
export const SessionEvent = Data.taggedEnum<SessionEvent>()

export const isReady = SessionEvent.$is("Ready")

type State = {
  readonly turn: number
  /** The first image, attached to every edit so drift cannot compound. */
  readonly anchor: Option.Option<ImageSource>
  readonly latest: Option.Option<ImageSource>
}

const start: State = { turn: 0, anchor: Option.none(), latest: Option.none() }

/**
 * The anchor and the last frame, deduplicated: on the second turn they are
 * the same image and sending it twice only wastes tokens.
 */
const references = (state: State, latest: ImageSource): ReadonlyArray<ImageSource> =>
  Option.match(state.anchor, {
    onNone: () => [latest],
    onSome: (anchor) => (anchor === latest ? [latest] : [anchor, latest]),
  })

/** Nothing drawn yet means there is nothing to edit. */
const frames = <R>(
  draw: Draw<R>,
  state: State,
  request: string,
): Stream.Stream<ImageStreamEvent, AiError.AiError, R> =>
  Option.match(state.latest, {
    onNone: () => draw(request, []),
    onSome: (latest) => draw(request, references(state, latest)),
  })

const finished = (
  images: ReadonlyArray<{ readonly image: ImageSource }>,
): Effect.Effect<ImageSource, AiError.AiError> =>
  Option.match(Arr.head(images), {
    onNone: () =>
      Effect.fail(
        new AiError.GenerationFailed({
          provider: "image",
          message: "The stream completed without an image.",
          raw: images,
        }),
      ),
    onSome: (generated) => Effect.succeed(generated.image),
  })

const turn = <R>(
  draw: Draw<R>,
  state: Ref.Ref<State>,
  request: string,
): Stream.Stream<SessionEvent, AiError.AiError, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const now = yield* Ref.get(state)
      const began = yield* Clock.currentTimeMillis
      const n = now.turn + 1
      return Stream.concat(
        Stream.succeed(SessionEvent.Started({ turn: n, request })),
        Stream.mapEffect(
          frames(draw, now, request),
          (event): Effect.Effect<SessionEvent, AiError.AiError> =>
            isPartialImage(event)
              ? Effect.succeed(
                  SessionEvent.Preview({ turn: n, index: event.index, image: event.image }),
                )
              : Effect.gen(function* () {
                  const image = yield* finished(event.images)
                  const millis = (yield* Clock.currentTimeMillis) - began
                  yield* Ref.set(state, {
                    turn: n,
                    anchor: Option.orElse(now.anchor, () => Option.some(image)),
                    latest: Option.some(image),
                  })
                  return SessionEvent.Ready({ turn: n, image, millis })
                }),
        ),
      )
    }),
  )

/**
 * One request at a time: the next edit needs the image the last one
 * produced, so `flatMap` pulls a request only once the previous turn has
 * finished. That back-pressure is what lets `app.ts` hand this a stream
 * that reads a line from the terminal.
 */
export const session = <E, R, RD>(
  requests: Stream.Stream<string, E, R>,
  draw: Draw<RD>,
): Stream.Stream<SessionEvent, E | AiError.AiError, R | RD> =>
  Stream.unwrap(
    Effect.map(Ref.make(start), (state) =>
      Stream.flatMap(requests, (request) => turn(draw, state, request)),
    ),
  )
