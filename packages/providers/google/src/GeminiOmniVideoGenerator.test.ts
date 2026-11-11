import { describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { imageBase64 } from "@effect-uai/core/Image"
import { VideoInput, videoRef } from "@effect-uai/core/Video"
import { expect } from "vitest"
import { WireInteraction, buildBody, stateOf } from "./GeminiOmniVideoGenerator.js"

const decode = Schema.decodeUnknownEffect(WireInteraction)

const HOST = "https://generativelanguage.googleapis.com/v1beta"

/** A settled interaction as the live API returned it (2026-11-11), signatures cut. */
const completed = (videoPart: unknown) => ({
  id: "v1_ChdRN2Iw",
  status: "completed",
  usage: { total_tokens: 58564, total_input_tokens: 21, total_output_tokens: 57920 },
  steps: [
    { type: "user_input", content: [{ type: "text", text: "Rain on a window." }] },
    { type: "thought", signature: "EopXCodX" },
    { type: "model_output", content: [videoPart] },
  ],
})

const frame = imageBase64("iVBORw0KGgo=", "image/png")
const request = { model: "gemini-omni-1.2-flash", prompt: "A fox in snow." }

describe("stateOf", () => {
  it.effect("turns a `uri` delivery into a Gemini file ref, not a fetchable URL", () =>
    Effect.gen(function* () {
      const wire = yield* decode(
        completed({
          type: "video",
          mime_type: "video/mp4",
          uri: `${HOST}/files/olnq5r6ymbjz:download?alt=media`,
        }),
      )
      const state = yield* stateOf(wire)
      expect(state).toMatchObject({
        _tag: "Succeeded",
        result: {
          videos: [{ video: videoRef("gemini", "files/olnq5r6ymbjz", "video/mp4") }],
          usage: { inputTokens: 21, outputTokens: 57920, totalTokens: 58564 },
        },
      })
    }),
  )

  it.effect("fails a URI it cannot read a file name from, rather than guessing", () =>
    Effect.gen(function* () {
      const wire = yield* decode(
        completed({ type: "video", uri: "https://elsewhere.example/clip.mp4" }),
      )
      expect((yield* Effect.flip(stateOf(wire)))._tag).toBe("GenerationFailed")
    }),
  )

  // Shape from Google's safety guide: a failed background interaction lists its errors.
  it.effect.each([
    ["safety", "ContentFiltered"],
    ["content_blocked", "ContentFiltered"],
    ["api_error", "GenerationFailed"],
  ] as const)("settles a failed interaction with error code %s as %s", ([code, tag]) =>
    Effect.gen(function* () {
      const message = "Request blocked due to safety violations (harmful content)."
      const wire = yield* decode({ id: "v1_x", status: "failed", errors: [{ code, message }] })
      expect(yield* stateOf(wire)).toMatchObject({ _tag: "Failed", error: { _tag: tag } })
    }),
  )

  it.effect("keeps polling an unknown status: the job may still be running", () =>
    Effect.gen(function* () {
      const wire = yield* decode({ id: "v1_x", status: "paused_for_review" })
      expect((yield* stateOf(wire))._tag).toBe("Running")
    }),
  )
})

describe("buildBody", () => {
  it.effect("sends first and last frame in order as image_to_video", () =>
    Effect.gen(function* () {
      const body = yield* buildBody(
        {
          ...request,
          inputs: [
            VideoInput.LastFrame({ image: imageBase64("TEFTVA==", "image/png") }),
            VideoInput.FirstFrame({ image: frame }),
          ],
        },
        HOST,
      )
      expect(body).toMatchObject({
        input: [
          { type: "image", data: frame.base64 },
          { type: "image", data: "TEFTVA==" },
          { type: "text", text: request.prompt },
        ],
        generation_config: { video_config: { task: "image_to_video" } },
      })
    }),
  )

  it.effect("feeds a Gemini file ref back as its Files API URI", () =>
    Effect.gen(function* () {
      const body = yield* buildBody(
        {
          ...request,
          inputs: [VideoInput.ReferenceVideo({ video: videoRef("gemini", "files/abc") })],
        },
        HOST,
      )
      expect(body).toMatchObject({
        input: [{ type: "video", uri: `${HOST}/files/abc` }, { type: "text" }],
        generation_config: { video_config: { task: "reference_to_video" } },
      })
    }),
  )

  it.effect.each([
    ["a last frame alone", [VideoInput.LastFrame({ image: frame })]],
    [
      "frames mixed with references",
      [VideoInput.FirstFrame({ image: frame }), VideoInput.ReferenceImage({ image: frame })],
    ],
    ["another provider's file ref", [VideoInput.ReferenceVideo({ video: videoRef("fal", "x") })]],
  ] as const)("fails Unsupported for %s", ([, inputs]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(buildBody({ ...request, inputs }, HOST))
      expect(error._tag).toBe("Unsupported")
    }),
  )
})
