import { Effect, Option, Redacted, Result, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import type * as Items from "@effect-uai/core/Items"
import { describe, expect, it } from "vitest"
import { make as makeAnthropic } from "./Anthropic.js"
import { buildRequestBody } from "./codec.js"

// `messageCacheControl` is left to its default, `{ type: "ephemeral" }`.
const bodyFor = (history: ReadonlyArray<Items.HistoryItem>) =>
  Result.getOrThrow(
    buildRequestBody({
      model: "claude-sonnet-4-5",
      history,
      maxTokens: 1024,
      temperature: Option.none(),
      topP: Option.none(),
      topK: Option.none(),
      stopSequences: Option.none(),
      thinking: Option.none(),
      tools: Option.none(),
      toolChoice: Option.none(),
      userId: Option.none(),
      outputConfig: Option.none(),
      cacheControl: Option.none(),
    }),
  )

const system = (text: string, cacheBreakpoint?: boolean): Items.Message => ({
  type: "message",
  role: "system",
  content: [{ type: "input_text", text }],
  ...(cacheBreakpoint !== undefined && { cacheBreakpoint }),
})

const user = (text: string, cacheBreakpoint?: boolean): Items.Message => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
  ...(cacheBreakpoint !== undefined && { cacheBreakpoint }),
})

describe("Message.cacheBreakpoint on Anthropic", () => {
  it("sends nothing new when no message is marked", () => {
    const body = bodyFor([system("rules"), system("more rules"), user("hi")])
    expect(body.system).toBe("rules\nmore rules")
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
    expect(body).not.toHaveProperty("cache_control")
  })

  it("splits system into blocks and marks only the marked message", () => {
    const body = bodyFor([system("long shared rules", true), system("per-call note"), user("hi")])
    expect(body.system).toEqual([
      { type: "text", text: "long shared rules", cache_control: { type: "ephemeral" } },
      { type: "text", text: "per-call note" },
    ])
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
  })

  it("marks the last block of a marked user message, not the merged turn", () => {
    const body = bodyFor([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "describe this" },
          { type: "input_image", source: { _tag: "url", url: "https://example.com/a.png" } },
        ],
        cacheBreakpoint: true,
      },
      user("and this one?"),
    ])
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          {
            type: "image",
            source: { type: "url", url: "https://example.com/a.png" },
            cache_control: { type: "ephemeral" },
          },
          { type: "text", text: "and this one?" },
        ],
      },
    ])
  })

  it("marks an assistant message's text block", () => {
    const body = bodyFor([
      user("hi"),
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }],
        cacheBreakpoint: true,
      },
      user("bye"),
    ])
    expect(body.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
    })
  })

  it("treats cacheBreakpoint: false as unmarked", () => {
    const body = bodyFor([system("rules", false), user("hi", false)])
    expect(body.system).toBe("rules")
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }])
  })
})

describe("Message.cacheBreakpoint TTL", () => {
  // Anthropic rejects a longer-TTL breakpoint after a shorter one, and the
  // request-level breakpoint sits after every message, so a marked message
  // has to take the layer's `promptCaching` TTL.
  const capturedBody = (cfg: { readonly promptCaching?: boolean | { readonly ttl?: "1h" } }) =>
    Effect.gen(function* () {
      const sent: Array<unknown> = []
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.body._tag === "Uint8Array") {
            sent.push(JSON.parse(new TextDecoder().decode(request.body.body)))
          }
          return HttpClientResponse.fromWeb(
            request,
            new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            }),
          )
        }),
      )
      const svc = yield* makeAnthropic({ apiKey: Redacted.make("k"), ...cfg }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      )
      yield* svc
        .streamTurn({ model: "claude-sonnet-4-5", history: [system("rules", true), user("hi")] })
        .pipe(Stream.runDrain, Effect.provideService(HttpClient.HttpClient, client))
      return sent[0] as { readonly system: unknown; readonly cache_control?: unknown }
    })

  it("uses the 5m default when promptCaching is off", async () => {
    const body = await Effect.runPromise(capturedBody({}))
    expect(body.system).toEqual([
      { type: "text", text: "rules", cache_control: { type: "ephemeral" } },
    ])
    expect(body).not.toHaveProperty("cache_control")
  })

  it("takes the promptCaching TTL alongside the request-level breakpoint", async () => {
    const body = await Effect.runPromise(capturedBody({ promptCaching: { ttl: "1h" } }))
    expect(body.system).toEqual([
      { type: "text", text: "rules", cache_control: { type: "ephemeral", ttl: "1h" } },
    ])
    expect(body.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })
})
