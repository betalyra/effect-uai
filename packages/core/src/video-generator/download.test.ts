import { describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { expect } from "vitest"
import { videoUrl } from "../domain/Video.js"
import { read } from "./download.js"

/** Answers every request with a few bytes under `status`. */
const serving = (status: number) =>
  Effect.provideService(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(new Uint8Array(8), { status })),
      ),
    ),
  )

describe("read", () => {
  it.effect("treats a body that breaks off mid-stream as transient, not as an expired link", () =>
    Effect.gen(function* () {
      const broken = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(new Uint8Array(8))
          controller.error(new Error("connection reset"))
        },
      })
      const error = yield* Effect.flip(
        Stream.runDrain(read(videoUrl("https://cdn.example/clip.mp4"), { provider: "fal" })),
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(broken))),
          ),
        ),
      )
      expect(error).toMatchObject({ _tag: "Unavailable", provider: "fal" })
    }),
  )

  it.effect.each([
    [401, "AuthFailed"],
    [403, "InvalidRequest"],
    [404, "InvalidRequest"],
    [429, "RateLimited"],
    [503, "Unavailable"],
  ] as const)("maps HTTP %i on a video URL to %s, naming the provider", ([status, tag]) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        Stream.runDrain(read(videoUrl("https://cdn.example/clip.mp4"), { provider: "fal" })),
      )
      expect(error).toMatchObject({ _tag: tag, provider: "fal" })
    }).pipe(serving(status)),
  )
})
