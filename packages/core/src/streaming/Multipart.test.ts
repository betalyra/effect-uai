import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { expect } from "vitest"
import { bodyMultipart } from "./Multipart.js"

describe("bodyMultipart", () => {
  it.effect("sends the boundary the encoded parts are delimited by", () =>
    Effect.gen(function* () {
      const form = new FormData()
      form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/ogg" }), "audio.ogg")
      form.set("model", "whisper-1")

      const request = HttpClientRequest.post("https://example.test/upload").pipe(
        yield* bodyMultipart(form),
      )
      const contentType = request.headers["content-type"] ?? ""
      const boundary = /boundary=(.+)$/.exec(contentType)?.[1]

      expect(boundary).toBeDefined()
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
      expect(body.startsWith(`--${boundary}\r\n`)).toBe(true)
    }),
  )
})
