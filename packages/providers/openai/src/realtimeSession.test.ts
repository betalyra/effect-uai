import { describe, it } from "@effect/vitest"
import { Effect, Encoding, Fiber, Redacted, Stream } from "effect"
import { expect } from "vitest"
import type { RealtimeEvent } from "@effect-uai/core/Realtime"
import { RealtimeInput } from "@effect-uai/core/Realtime"
import type { RealtimeSessionHandle } from "@effect-uai/core/RealtimeSession"
import * as FakeWebSocket from "@effect-uai/core/testing/FakeWebSocket"
import { type OpenAIRealtimeRequest, openSession } from "./realtimeSession.js"

const pcm = { container: "raw", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 } as const

const request: OpenAIRealtimeRequest = {
  model: "gpt-realtime-2.1",
  instructions: "be terse",
  voiceId: "marin",
  inputFormat: pcm,
  outputFormat: pcm,
}

const cfg = { apiKey: Redacted.make("test-key") }

/** Greets like OpenAI and acks the configuration, which is all `open` waits for. */
const openai = FakeWebSocket.make({
  greeting: [{ type: "session.created", session: { id: "sess_1", expires_at: 4102444800 } }],
  reply: (frame) =>
    Effect.succeed(
      (frame as { type?: string }).type === "session.update" ? [{ type: "session.updated" }] : [],
    ),
})

/** Let the socket's own turn and the adapter's fibers run. */
const tick = Effect.sleep("5 millis")

/**
 * Open a session, run `script` against it, then close and hand back everything
 * the caller would have seen.
 */
const transcript = (
  server: FakeWebSocket.FakeWebSocketServer,
  script: (handle: RealtimeSessionHandle) => Effect.Effect<void, unknown>,
  options?: { readonly closeCode?: number; readonly request?: OpenAIRealtimeRequest },
) =>
  Effect.gen(function* () {
    const handle = yield* openSession({ ...cfg, webSocket: server.connect })(
      options?.request ?? request,
    )
    const collector = yield* Effect.forkChild(Effect.exit(Stream.runCollect(handle.events)))
    yield* script(handle)
    yield* tick
    yield* server.close(options?.closeCode ?? 1000)
    return yield* Fiber.join(collector)
  })

const tags = (events: ReadonlyArray<RealtimeEvent>) => events.map((e) => e._tag)

const eventsOf = (exit: { _tag: string; value?: unknown }): ReadonlyArray<RealtimeEvent> =>
  exit._tag === "Success" ? (exit.value as ReadonlyArray<RealtimeEvent>) : []

describe("OpenAI realtime session handshake", () => {
  it.live("configures the GA session shape, and only then resolves `open`", () =>
    Effect.gen(function* () {
      const server = yield* openai
      yield* transcript(server, () => Effect.void)

      const sent = yield* server.sent
      const update = sent.find((f: any) => f.type === "session.update") as any
      expect(update.session.type).toBe("realtime")
      expect(update.session.instructions).toBe("be terse")
      expect(update.session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24000 })
      expect(update.session.audio.input.turn_detection).toEqual({ type: "server_vad" })
      expect(update.session.audio.input.transcription).toEqual({ model: "gpt-live-transcribe" })
      expect(update.session.audio.output.voice).toBe("marin")
    }).pipe(Effect.scoped),
  )

  it.live("asks for no turn detection when the caller drives the turns", () =>
    Effect.gen(function* () {
      const server = yield* openai
      yield* transcript(server, () => Effect.void, {
        request: { ...request, turnDetection: "manual" },
      })

      const sent = yield* server.sent
      const update = sent.find((f: any) => f.type === "session.update") as any
      expect(update.session.audio.input.turn_detection).toBeNull()
    }).pipe(Effect.scoped),
  )
})

describe("OpenAI realtime session responses", () => {
  it.live("brackets audio and transcript deltas with the response boundaries", () =>
    Effect.gen(function* () {
      const server = yield* openai
      const exit = yield* transcript(server, () =>
        Effect.gen(function* () {
          yield* server.push({ type: "response.created", response: { id: "resp_1" } })
          yield* server.push({
            type: "response.output_audio.delta",
            response_id: "resp_1",
            delta: Encoding.encodeBase64(new Uint8Array([1, 2, 3])),
          })
          yield* server.push({
            type: "response.output_audio_transcript.delta",
            response_id: "resp_1",
            delta: "hi",
          })
          yield* server.push({
            type: "response.done",
            response: {
              id: "resp_1",
              status: "completed",
              usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
            },
          })
        }),
      )

      const events = eventsOf(exit)
      expect(tags(events)).toEqual([
        "ResponseStarted",
        "AudioDelta",
        "OutputTranscriptDelta",
        "ResponseDone",
      ])
      const audio = events[1]
      expect(audio?._tag === "AudioDelta" && Array.from(audio.bytes)).toEqual([1, 2, 3])
      const done = events[3]
      expect(done?._tag === "ResponseDone" && done.reason).toBe("complete")
      expect(done?._tag === "ResponseDone" && done.usage?.total_tokens).toBe(30)
    }).pipe(Effect.scoped),
  )

  it.live("reports barge-in as an interruption before the cancelled response ends", () =>
    Effect.gen(function* () {
      const server = yield* openai
      const exit = yield* transcript(server, () =>
        Effect.gen(function* () {
          yield* server.push({ type: "response.created", response: { id: "resp_1" } })
          yield* server.push({
            type: "response.output_item.added",
            response_id: "resp_1",
            item: { id: "call_item", type: "function_call", call_id: "call_1", name: "get_time" },
          })
          yield* server.push({ type: "input_audio_buffer.speech_started" })
          yield* server.push({
            type: "response.done",
            response: {
              id: "resp_1",
              status: "cancelled",
              status_details: { reason: "turn_detected" },
            },
          })
        }),
      )

      const events = eventsOf(exit)
      expect(tags(events)).toEqual([
        "ResponseStarted",
        "SpeechStarted",
        "Interrupted",
        "ToolCallCancelled",
        "ResponseDone",
      ])
      const cancelled = events[3]
      expect(cancelled?._tag === "ToolCallCancelled" && cancelled.callIds).toEqual(["call_1"])
      const done = events[4]
      expect(done?._tag === "ResponseDone" && done.reason).toBe("interrupted")
    }).pipe(Effect.scoped),
  )

  it.live("ends the stream as an incomplete turn when a response is still running", () =>
    Effect.gen(function* () {
      const server = yield* openai
      const exit = yield* transcript(server, () =>
        server.push({ type: "response.created", response: { id: "resp_1" } }),
      )

      // A close must never look like a finished response.
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("IncompleteTurn")
    }).pipe(Effect.scoped),
  )
})

describe("OpenAI realtime session tools", () => {
  it.live("names the call from the item that announced it, and resumes after the result", () =>
    Effect.gen(function* () {
      const server = yield* openai
      const exit = yield* transcript(server, (handle) =>
        Effect.gen(function* () {
          yield* server.push({ type: "response.created", response: { id: "resp_1" } })
          yield* server.push({
            type: "response.output_item.added",
            response_id: "resp_1",
            item: { id: "call_item", type: "function_call", call_id: "call_1", name: "get_time" },
          })
          // The `.done` frame carries no name, so it comes from the item above.
          yield* server.push({
            type: "response.function_call_arguments.done",
            response_id: "resp_1",
            call_id: "call_1",
            arguments: '{"tz":"UTC"}',
          })
          yield* server.push({
            type: "response.done",
            response: { id: "resp_1", status: "completed" },
          })
          yield* tick
          yield* handle.send(
            RealtimeInput.ToolResult({
              output: {
                type: "function_call_output",
                call_id: "call_1",
                output: '{"now":"12:00"}',
                providerData: undefined,
              },
            }),
          )
        }),
      )

      const toolCall = eventsOf(exit).find((e) => e._tag === "ToolCall")
      expect(toolCall?._tag === "ToolCall" && toolCall.call.name).toBe("get_time")
      expect(toolCall?._tag === "ToolCall" && toolCall.call.arguments).toBe('{"tz":"UTC"}')

      const sent = yield* server.sent
      const output = sent.find((f: any) => f.item?.type === "function_call_output") as any
      expect(output.item).toEqual({
        type: "function_call_output",
        call_id: "call_1",
        output: '{"now":"12:00"}',
      })
      // The adapter asks for the follow-up turn, so the caller never does.
      expect(sent.filter((f: any) => f.type === "response.create")).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.live("waits for the active response to finish before asking for the tool's turn", () =>
    Effect.gen(function* () {
      const server = yield* openai
      yield* transcript(server, (handle) =>
        Effect.gen(function* () {
          yield* server.push({ type: "response.created", response: { id: "resp_1" } })
          yield* server.push({
            type: "response.output_item.added",
            response_id: "resp_1",
            item: { id: "call_item", type: "function_call", call_id: "call_1", name: "get_time" },
          })
          yield* tick
          // The tool answers while the user's own turn is still generating.
          // Asking for another response now is rejected by the server.
          yield* handle.send(
            RealtimeInput.ToolResult({
              output: {
                type: "function_call_output",
                call_id: "call_1",
                output: "{}",
                providerData: undefined,
              },
            }),
          )
          yield* tick
          const midway = yield* server.sent
          expect(midway.filter((f: any) => f.type === "response.create")).toHaveLength(0)

          yield* server.push({
            type: "response.done",
            response: { id: "resp_1", status: "completed" },
          })
        }),
      )

      const sent = yield* server.sent
      expect(sent.filter((f: any) => f.type === "response.create")).toHaveLength(1)
    }).pipe(Effect.scoped),
  )

  it.live("rejects a result for a call this session never made", () =>
    Effect.gen(function* () {
      const server = yield* openai
      const handle = yield* openSession({ ...cfg, webSocket: server.connect })(request)
      const failure = yield* Effect.exit(
        handle.send(
          RealtimeInput.ToolResult({
            output: {
              type: "function_call_output",
              call_id: "call_unknown",
              output: "{}",
              providerData: undefined,
            },
          }),
        ),
      )

      expect(failure._tag).toBe("Failure")
      expect(JSON.stringify(failure)).toContain("InvalidRequest")
      const sent = yield* server.sent
      expect(sent.some((f: any) => f.item?.type === "function_call_output")).toBe(false)
    }).pipe(Effect.scoped),
  )
})

describe("OpenAI realtime session inputs", () => {
  it.live("truncates the assistant item at what the user actually heard", () =>
    Effect.gen(function* () {
      const server = yield* openai
      yield* transcript(server, (handle) =>
        Effect.gen(function* () {
          yield* server.push({ type: "response.created", response: { id: "resp_1" } })
          yield* server.push({
            type: "response.output_item.added",
            response_id: "resp_1",
            item: { id: "item_1", type: "message" },
          })
          yield* tick
          yield* handle.send(
            RealtimeInput.PlaybackPosition({ responseId: "resp_1", playedMs: 1234.6 }),
          )
          yield* server.push({
            type: "response.done",
            response: { id: "resp_1", status: "completed" },
          })
        }),
      )

      const sent = yield* server.sent
      expect(sent.find((f: any) => f.type === "conversation.item.truncate")).toEqual({
        type: "conversation.item.truncate",
        item_id: "item_1",
        content_index: 0,
        audio_end_ms: 1235,
      })
    }).pipe(Effect.scoped),
  )

  it.live("refuses video, which this provider has no wire op for", () =>
    Effect.gen(function* () {
      const server = yield* openai
      const handle = yield* openSession({ ...cfg, webSocket: server.connect })(request)
      const failure = yield* Effect.exit(
        handle.send(
          RealtimeInput.VideoFrame({
            frame: { _tag: "base64", base64: "aW1n", mimeType: "image/jpeg" },
          }),
        ),
      )

      expect(failure._tag).toBe("Failure")
      expect(JSON.stringify(failure)).toContain("Unsupported")
    }).pipe(Effect.scoped),
  )
})
