import { Effect, Exit, Redacted, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { TurnEvent } from "@effect-uai/core/Turn"
import { make as makeMistral } from "./Mistral.js"

// An HttpClient backed by a scripted SSE body
const clientWithBody = (makeBody: () => ReadableStream<Uint8Array>): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(makeBody(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    ),
  )

const enc = new TextEncoder()
const sse = (obj: unknown) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`)

const runStream = (client: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const svc = yield* makeMistral({ apiKey: Redacted.make("k") })
    const events: Array<TurnEvent> = []
    const exit = yield* svc.streamTurn({ model: "mistral-small-latest", history: [] }).pipe(
      Stream.runForEach((e) => Effect.sync(() => events.push(e))),
      Effect.exit,
    )
    return { tags: events.map((e) => e._tag), events, exit }
  }).pipe(Effect.provideService(HttpClient.HttpClient, client))

describe("Mistral streamTurn: truncated turn presented as complete", () => {
  it("truncated EOF (no finish_reason) must not synthesize a complete turn", async () => {
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse({ choices: [{ delta: { content: "Hel" } }] }))
          controller.close() // no finish_reason, no [DONE]
        },
      })
    const { tags } = await Effect.runPromise(runStream(clientWithBody(body)))
    expect(tags).toContain("TextDelta")
    expect(tags).not.toContain("TurnComplete")
  })

  it("mid-stream error must surface as a failure, not a fake TurnComplete", async () => {
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse({ choices: [{ delta: { content: "Hel" } }] }))
          controller.error(new Error("connection reset"))
        },
      })
    const { tags, exit } = await Effect.runPromise(runStream(clientWithBody(body)))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(tags).not.toContain("TurnComplete")
  })

  it("a well-formed stream (finish_reason present) still completes", async () => {
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(sse({ choices: [{ delta: { content: "Hel" } }] }))
          controller.enqueue(sse({ choices: [{ delta: {}, finish_reason: "stop" }] }))
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
    const { tags } = await Effect.runPromise(runStream(clientWithBody(body)))
    expect(tags).toContain("TurnComplete")
  })
})
