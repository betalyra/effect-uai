import { Context, Data, Effect, Stream } from "effect"
import type * as AiError from "../domain/AiError.js"
import type { AspectRatio, GeneratedImage, ImageResolution, ImageSource } from "../domain/Image.js"

export type { AspectRatio, GeneratedImage, ImageResolution } from "../domain/Image.js"

/**
 * Cross-provider text-to-image request. Shape and resolution are given
 * as a ratio plus a tier rather than exact pixels: every provider takes
 * one or derives the other. Exact dimensions, quality tiers, output
 * encodings, and moderation knobs are vendor-specific and live on each
 * provider's typed request.
 */
export type CommonImageGenerateRequest = {
  readonly prompt: string
  /** Each provider narrows this to its typed literal union. */
  readonly model: string
  readonly aspectRatio?: AspectRatio
  readonly resolution?: ImageResolution
  /** Default 1. Implementors without multi-image output fail `Unsupported` for more. */
  readonly n?: number
}

/**
 * Edit request: the same prompt-driven generation, conditioned on
 * reference images. Separate from `generate` because the reference set
 * is required here and absent there, and providers expose the two as
 * distinct wire shapes. Per-provider caps on the array length apply.
 */
export type CommonImageEditRequest = CommonImageGenerateRequest & {
  readonly images: ReadonlyArray<ImageSource>
}

/** Gated by {@link ImageStreaming}; `partialImages` is the preview-frame count. */
export type CommonStreamImageRequest = CommonImageGenerateRequest & {
  readonly partialImages: 1 | 2 | 3
}

/** Optional throughout: not every provider bills or reports per token. */
export type ImageUsage = {
  readonly inputTokens?: number
  readonly outputTokens?: number
  readonly totalTokens?: number
}

export type ImageResponse = {
  readonly images: ReadonlyArray<GeneratedImage>
  readonly usage: ImageUsage
}

/**
 * Zero or more `PartialImage` previews, then exactly one `Complete`.
 * `Complete` carries the `ImageResponse` fields flat, so it is
 * assignable to `ImageResponse` and needs no unwrapping.
 */
export type ImageStreamEvent = Data.TaggedEnum<{
  PartialImage: {
    readonly image: ImageSource
    /** Counts from 0 in emission order. */
    readonly index: number
  }
  Complete: {
    readonly images: ReadonlyArray<GeneratedImage>
    readonly usage: ImageUsage
  }
}>

/**
 * Namespace of constructors, type guards, and matchers for
 * `ImageStreamEvent`, provided by `Data.taggedEnum`.
 */
export const ImageStreamEvent = Data.taggedEnum<ImageStreamEvent>()

export const isPartialImage = ImageStreamEvent.$is("PartialImage")
export const isComplete = ImageStreamEvent.$is("Complete")

export type ImageGeneratorService = {
  /** Prompt in, images out. Universally supported. */
  readonly generate: (
    request: CommonImageGenerateRequest,
  ) => Effect.Effect<ImageResponse, AiError.AiError>
  /** Prompt plus reference images in, images out. Universally supported. */
  readonly edit: (request: CommonImageEditRequest) => Effect.Effect<ImageResponse, AiError.AiError>
  /**
   * Preview frames as the image resolves, then the final response.
   * Implementors without a partial-image wire return `Unsupported` and
   * do NOT register {@link ImageStreaming}, so the top-level helper is
   * a compile-time error against their Layer.
   */
  readonly streamGeneration: (
    request: CommonStreamImageRequest,
  ) => Stream.Stream<ImageStreamEvent, AiError.AiError>
}

export class ImageGenerator extends Context.Service<ImageGenerator, ImageGeneratorService>()(
  "@betalyra/effect-uai/ImageGenerator",
) {}

/**
 * Capability marker for partial-image streaming. Phantom: the value is
 * `void`, providers register with
 * `Layer.succeed(ImageStreaming, undefined)`. Calling
 * {@link streamGeneration} while only a non-streaming Layer is in scope
 * fails at `Effect.provide` with a type error.
 */
export class ImageStreaming extends Context.Service<ImageStreaming, void>()(
  "@betalyra/effect-uai/capability/ImageStreaming",
) {}

/** Text to image. */
export const generate = (
  request: CommonImageGenerateRequest,
): Effect.Effect<ImageResponse, AiError.AiError, ImageGenerator> =>
  Effect.flatMap(ImageGenerator, (g) => g.generate(request))

/** Text plus reference images to image. */
export const edit = (
  request: CommonImageEditRequest,
): Effect.Effect<ImageResponse, AiError.AiError, ImageGenerator> =>
  Effect.flatMap(ImageGenerator, (g) => g.edit(request))

/** Preview frames then the final response. Requires {@link ImageStreaming} in R. */
export const streamGeneration = (
  request: CommonStreamImageRequest,
): Stream.Stream<ImageStreamEvent, AiError.AiError, ImageGenerator | ImageStreaming> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const g = yield* ImageGenerator
      yield* ImageStreaming
      return g.streamGeneration(request)
    }),
  )
