import { describe, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option } from "effect"
import { expect } from "vitest"
import type * as AiError from "@effect-uai/core/AiError"
import { imageBase64, imageBytes, imageUrl } from "@effect-uai/core/Image"
import { ImageStreamEvent } from "@effect-uai/core/ImageGenerator"
import * as OpenAIImageGenerator from "./OpenAIImageGenerator.js"

const errorOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined

const frame = (data: unknown) => ({ data: JSON.stringify(data) })

describe("sizeOf", () => {
  it.effect("puts the tier on the short edge and scales the long one to the ratio", () =>
    Effect.gen(function* () {
      // Landscape scales the width, portrait the height, both rounded to the
      // multiple of 16 the endpoint requires (16:9 of 2048 is 3640.9).
      expect(yield* OpenAIImageGenerator.sizeOf({ aspectRatio: "16:9", resolution: "2K" })).toBe(
        "3648x2048",
      )
      expect(yield* OpenAIImageGenerator.sizeOf({ aspectRatio: "9:16", resolution: "1K" })).toBe(
        "1024x1824",
      )
      // Half a request still derives: square without a ratio, 1K without a tier.
      expect(yield* OpenAIImageGenerator.sizeOf({ resolution: "4K" })).toBe("4096x4096")
      expect(yield* OpenAIImageGenerator.sizeOf({ aspectRatio: "3:2" })).toBe("1536x1024")
    }),
  )

  it.effect("lets an explicit `size` win over the ratio and tier", () =>
    Effect.gen(function* () {
      const size = yield* OpenAIImageGenerator.sizeOf({
        size: "1536x1024",
        aspectRatio: "1:1",
        resolution: "4K",
      })
      expect(size).toBe("1536x1024")
    }),
  )

  it.effect("fails InvalidRequest on a ratio it cannot turn into pixels", () =>
    Effect.gen(function* () {
      for (const aspectRatio of ["wide", "-16:9", "0:1", "16:9:4", "16"]) {
        const exit = yield* Effect.exit(OpenAIImageGenerator.sizeOf({ aspectRatio }))
        const error = errorOf(exit)
        expect(error?._tag, aspectRatio).toBe("InvalidRequest")
        expect((error as AiError.InvalidRequest).param).toBe("aspectRatio")
      }
    }),
  )
})

describe("editForm", () => {
  const editRequest = {
    prompt: "make it dawn",
    model: "gpt-image-2",
    images: [imageBase64("aW1n", "image/png"), imageBytes(new Uint8Array([1, 2, 3]), "image/webp")],
    mask: imageBase64("bWFzaw==", "image/png"),
    quality: "high",
  } as const

  it.effect("uploads several references as repeated `image[]` parts, named by format", () =>
    Effect.gen(function* () {
      const form = yield* OpenAIImageGenerator.editForm(editRequest)
      const images = form.getAll("image[]") as ReadonlyArray<File>
      expect(images.map((f) => f.name)).toEqual(["image-0.png", "image-1.webp"])
      expect(images.map((f) => f.type)).toEqual(["image/png", "image/webp"])
      expect((form.get("mask") as File).name).toBe("image-0.png")
      // Knobs ride along as strings, as multipart requires.
      expect(form.get("quality")).toBe("high")
      expect(form.get("model")).toBe("gpt-image-2")
    }),
  )

  it.effect("sends a lone reference as `image`, the endpoint's required field", () =>
    Effect.gen(function* () {
      // `image[]` is the multi-file spelling only. A server implementing just
      // the single-file schema rejects it with "Missing required parameter".
      const form = yield* OpenAIImageGenerator.editForm({
        ...editRequest,
        images: [imageBase64("aW1n", "image/png")],
      })
      expect((form.get("image") as File).name).toBe("image-0.png")
      expect(form.getAll("image[]")).toEqual([])
    }),
  )

  it("rejects a URL reference at compile time: multipart uploads bytes", () => {
    const url = imageUrl("https://example.com/a.png", "image/png")
    // @ts-expect-error: `images` is narrowed to the inline variants.
    const request: OpenAIImageGenerator.OpenAIImageEditRequest = { ...editRequest, images: [url] }
    expect(request).toBeDefined()
  })

  it.effect("still fails InvalidRequest when a URL arrives through the generic tag", () =>
    Effect.gen(function* () {
      // The generic `edit` takes the full `ImageSource` union and the Layer
      // casts, so the runtime rejection stays as the backstop.
      const exit = yield* Effect.exit(
        OpenAIImageGenerator.editForm({
          ...editRequest,
          images: [imageUrl("https://example.com/a.png", "image/png") as never],
        }),
      )
      const error = errorOf(exit)
      expect(error?._tag).toBe("InvalidRequest")
      expect((error as AiError.InvalidRequest).param).toBe("images")
    }),
  )
})

describe("response decoding", () => {
  const decode = (json: unknown, requested?: "png" | "jpeg" | "webp") =>
    Effect.flatMap(OpenAIImageGenerator.decodeImagesResponse(json), (wire) =>
      OpenAIImageGenerator.toResponse(wire, requested),
    )

  it.effect("resolves the MIME from the echoed format, then the requested one, then png", () =>
    Effect.gen(function* () {
      const echoed = yield* decode({ data: [{ b64_json: "aW1n" }], output_format: "webp" }, "jpeg")
      expect(echoed.images[0]!.image).toEqual(imageBase64("aW1n", "image/webp"))
      const requested = yield* decode({ data: [{ b64_json: "aW1n" }] }, "jpeg")
      expect(requested.images[0]!.image).toEqual(imageBase64("aW1n", "image/jpeg"))
      const fallback = yield* decode({ data: [{ b64_json: "aW1n" }] })
      expect(fallback.images[0]!.image).toEqual(imageBase64("aW1n", "image/png"))
    }),
  )

  it.effect("maps usage and accepts the narrower payload a gateway returns", () =>
    Effect.gen(function* () {
      const full = yield* decode({
        created: 1,
        data: [{ b64_json: "aW1n" }],
        usage: { input_tokens: 12, output_tokens: 1120, total_tokens: 1132 },
      })
      expect(full.usage).toEqual({ inputTokens: 12, outputTokens: 1120, totalTokens: 1132 })
      // No `created`, no `usage`, and a URL where GPT image models send base64.
      const subset = yield* decode({ data: [{ url: "https://cdn.example.com/a.png" }] })
      expect(subset.images).toEqual([
        { image: imageUrl("https://cdn.example.com/a.png", "image/png") },
      ])
      expect(subset.usage).toEqual({})
    }),
  )

  it.effect("fails GenerationFailed when no entry carries an image", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(decode({ created: 1, data: [{ revised_prompt: "..." }] }))
      expect(errorOf(exit)?._tag).toBe("GenerationFailed")
    }),
  )
})

describe("error classification", () => {
  it.effect("maps a moderation block to ContentFiltered, carrying the message", () =>
    Effect.gen(function* () {
      const body = JSON.stringify({
        error: {
          type: "image_generation_user_error",
          code: "moderation_blocked",
          message: "Your request was rejected.",
        },
      })
      const error = yield* OpenAIImageGenerator.imageHttpError(400, body)
      expect(error._tag).toBe("ContentFiltered")
      expect((error as AiError.ContentFiltered).reason).toBe("Your request was rejected.")
    }),
  )

  it.effect("leaves every other error to the shared status mapping", () =>
    Effect.gen(function* () {
      const other = JSON.stringify({ error: { code: "invalid_value", message: "bad size" } })
      expect((yield* OpenAIImageGenerator.imageHttpError(400, other))._tag).toBe("InvalidRequest")
      expect((yield* OpenAIImageGenerator.imageHttpError(429, other))._tag).toBe("RateLimited")
      // A body that is not JSON at all still classifies by status.
      expect((yield* OpenAIImageGenerator.imageHttpError(503, "<html>"))._tag).toBe("Unavailable")
    }),
  )

  it.effect("treats a non-moderation failure mid-stream as GenerationFailed", () =>
    Effect.gen(function* () {
      // The HTTP status was 200, so the status mapping has nothing to say.
      const error = yield* OpenAIImageGenerator.imageStreamError(
        JSON.stringify({ error: { code: "server_error" } }),
      )
      expect(error._tag).toBe("GenerationFailed")
    }),
  )
})

describe("stream frames", () => {
  it.effect("discriminates partials from the completed frame", () =>
    Effect.gen(function* () {
      const partial = yield* OpenAIImageGenerator.streamEventOf(
        frame({
          type: "image_generation.partial_image",
          b64_json: "cDE=",
          partial_image_index: 1,
          output_format: "webp",
        }),
        undefined,
      )
      expect(partial).toEqual(
        ImageStreamEvent.PartialImage({ image: imageBase64("cDE=", "image/webp"), index: 1 }),
      )

      const completed = yield* OpenAIImageGenerator.streamEventOf(
        frame({
          type: "image_generation.completed",
          b64_json: "ZG9uZQ==",
          usage: { total_tokens: 1132 },
        }),
        undefined,
      )
      expect(completed).toEqual(
        ImageStreamEvent.Complete({
          images: [{ image: imageBase64("ZG9uZQ==", "image/png") }],
          usage: { totalTokens: 1132 },
        }),
      )
    }),
  )

  it.effect("drops frames it has no representation for instead of failing the stream", () =>
    Effect.gen(function* () {
      const unknown = yield* OpenAIImageGenerator.streamEventOf(
        frame({ type: "image_generation.queued" }),
        undefined,
      )
      expect(unknown).toBeUndefined()
      const garbage = yield* OpenAIImageGenerator.streamEventOf({ data: "not json" }, undefined)
      expect(garbage).toBeUndefined()
    }),
  )

  it.effect("fails the stream on an error frame, moderation included", () =>
    Effect.gen(function* () {
      const blocked = yield* Effect.exit(
        OpenAIImageGenerator.streamEventOf(
          { event: "error", data: JSON.stringify({ error: { code: "moderation_blocked" } }) },
          undefined,
        ),
      )
      expect(errorOf(blocked)?._tag).toBe("ContentFiltered")

      const broke = yield* Effect.exit(
        OpenAIImageGenerator.streamEventOf({ event: "error", data: "boom" }, undefined),
      )
      expect(errorOf(broke)?._tag).toBe("GenerationFailed")
    }),
  )
})
