import { describe, it } from "@effect/vitest"
import { Duration, Effect, Encoding, Fiber, Logger, Redacted, Ref, Stream } from "effect"
import { expect } from "vitest"
import type { RealtimeEvent } from "@effect-uai/core/Realtime"
import { RealtimeInput } from "@effect-uai/core/Realtime"
import type { RealtimeSessionHandle } from "@effect-uai/core/RealtimeSession"
import * as FakeWebSocket from "@effect-uai/core/testing/FakeWebSocket"
import { type GeminiLiveRequest, openSession } from "./realtimeSession.js"

const request: GeminiLiveRequest = {
  model: "gemini-3.1-flash-live-preview",
  instructions: "be terse",
  voiceId: "Kore",
  inputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 16000, channels: 1 },
  outputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
}

const cfg = { apiKey: Redacted.make("test-key") }

/** The client speaks first here, so the handshake answers `setup`. */
const gemini = FakeWebSocket.make({
  reply: (frame) =>
    Effect.succeed(Object.hasOwn(frame as object, "setup") ? [{ setupComplete: {} }] : []),
})

/** Let the socket's own turn and the adapter's fibers run. */
const tick = Effect.sleep("5 millis")

/**
 * Events are recorded as they arrive rather than collected at the end, so a
 * run that ends in a failure still says what the caller saw before it.
 */
const transcript = (
  server: FakeWebSocket.FakeWebSocketServer,
  script: (handle: RealtimeSessionHandle) => Effect.Effect<void, unknown>,
  options?: { readonly closeCode?: number },
) =>
  Effect.gen(function* () {
    const handle = yield* openSession({ ...cfg, webSocket: server.connect })(request)
    const seen = yield* Ref.make<ReadonlyArray<RealtimeEvent>>([])
    const collector = yield* Effect.forkChild(
      Effect.exit(Stream.runForEach(handle.events, (e) => Ref.update(seen, (xs) => [...xs, e]))),
    )
    yield* script(handle)
    yield* tick
    yield* server.close(options?.closeCode ?? 1000)
    const exit = yield* Fiber.join(collector)
    return { exit, events: yield* Ref.get(seen) }
  })

const tags = (events: ReadonlyArray<RealtimeEvent>) => events.map((e) => e._tag)

const audioPart = (bytes: ReadonlyArray<number>) => ({
  inlineData: {
    mimeType: "audio/pcm;rate=24000",
    data: Encoding.encodeBase64(new Uint8Array(bytes)),
  },
})

describe("Gemini live session turns", () => {
  it.live("mints one turn id for a whole answer, and reports its usage at the end", () =>
    Effect.gen(function* () {
      const server = yield* gemini
      const { events } = yield* transcript(server, () =>
        Effect.gen(function* () {
          // 3.1 packs several parts, and their transcription, into one message.
          yield* server.push({
            serverContent: {
              modelTurn: { parts: [audioPart([1, 2, 3]), { thought: true, text: "planning" }] },
              outputTranscription: { text: "hi" },
            },
          })
          yield* server.push({
            serverContent: { modelTurn: { parts: [audioPart([4, 5])] } },
            usageMetadata: { promptTokenCount: 10, responseTokenCount: 20, totalTokenCount: 30 },
          })
          yield* server.push({ serverContent: { turnComplete: true } })
        }),
      )

      // The thought part is the model reasoning, not something to speak.
      expect(tags(events)).toEqual([
        "ResponseStarted",
        "AudioDelta",
        "OutputTranscriptDelta",
        "AudioDelta",
        "ResponseDone",
      ])
      // The wire carries no response id, so every event of the turn shares one.
      expect(new Set(events.map((e) => ("responseId" in e ? e.responseId : "")))).toEqual(
        new Set(["turn_1"]),
      )
      const done = events[4]
      expect(done?._tag === "ResponseDone" && done.reason).toBe("complete")
      expect(done?._tag === "ResponseDone" && done.usage?.total_tokens).toBe(30)
    }).pipe(Effect.scoped),
  )

  it.live("ends an interrupted turn once, and numbers the next one after it", () =>
    Effect.gen(function* () {
      const server = yield* gemini
      const { events } = yield* transcript(server, () =>
        Effect.gen(function* () {
          yield* server.push({ serverContent: { modelTurn: { parts: [audioPart([1])] } } })
          yield* server.push({ serverContent: { interrupted: true } })
          // The server follows an interruption with `turnComplete`, which
          // would otherwise end the same turn a second time.
          yield* server.push({ serverContent: { turnComplete: true } })
          yield* server.push({ serverContent: { modelTurn: { parts: [audioPart([2])] } } })
          yield* server.push({ serverContent: { turnComplete: true } })
        }),
      )

      expect(tags(events)).toEqual([
        "ResponseStarted",
        "AudioDelta",
        "Interrupted",
        "ResponseDone",
        "ResponseStarted",
        "AudioDelta",
        "ResponseDone",
      ])
      const interrupted = events[3]
      expect(interrupted?._tag === "ResponseDone" && interrupted.reason).toBe("interrupted")
      const next = events[4]
      expect(next?._tag === "ResponseStarted" && next.responseId).toBe("turn_2")
    }).pipe(Effect.scoped),
  )

  it.live("marks the user's words interim until the utterance is transcribed", () =>
    Effect.gen(function* () {
      const server = yield* gemini
      const { events } = yield* transcript(server, () =>
        Effect.gen(function* () {
          yield* server.push({ serverContent: { interimInputTranscription: { text: "weather" } } })
          yield* server.push({
            serverContent: { inputTranscription: { text: "weather in Lisbon" } },
          })
        }),
      )

      // A transcript belongs to no turn, so none is started for it.
      expect(events).toEqual([
        { _tag: "InputTranscript", text: "weather", final: false },
        { _tag: "InputTranscript", text: "weather in Lisbon", final: true },
      ])
    }).pipe(Effect.scoped),
  )

  it.live("ends the stream as an incomplete turn when a turn is still running", () =>
    Effect.gen(function* () {
      const server = yield* gemini
      const { exit } = yield* transcript(server, () =>
        server.push({ serverContent: { modelTurn: { parts: [audioPart([1])] } } }),
      )

      // A close must never look like a finished turn.
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("IncompleteTurn")
    }).pipe(Effect.scoped),
  )

  it.live("fails when the socket closes before the configuration is accepted", () =>
    Effect.gen(function* () {
      const mute = yield* FakeWebSocket.make()
      const opened = yield* Effect.forkChild(
        Effect.exit(openSession({ ...cfg, webSocket: mute.connect })(request)),
      )
      yield* tick
      yield* mute.close(1000)

      const exit = yield* Fiber.join(opened)
      expect(exit._tag).toBe("Failure")
      expect(JSON.stringify(exit)).toContain("Unavailable")
    }).pipe(Effect.scoped),
  )
})

describe("Gemini live session tools", () => {
  it.live("answers a call with the name the server gave it", () =>
    Effect.gen(function* () {
      const server = yield* gemini
      const { events } = yield* transcript(server, (handle) =>
        Effect.gen(function* () {
          yield* server.push({
            toolCall: {
              functionCalls: [{ id: "fc_1", name: "get_weather", args: { city: "Lisbon" } }],
            },
          })
          yield* tick
          yield* handle.send(
            RealtimeInput.ToolResult({
              output: {
                type: "function_call_output",
                call_id: "fc_1",
                output: '{"celsius":32}',
                providerData: undefined,
              },
            }),
          )
          yield* server.push({ serverContent: { turnComplete: true } })
        }),
      )

      const call = events.find((e) => e._tag === "ToolCall")
      expect(call?._tag === "ToolCall" && call.call.arguments).toBe('{"city":"Lisbon"}')
      // A call arrives with no turn open, so it gets one of its own.
      expect(call?._tag === "ToolCall" && call.responseId).toBe("turn_1")

      const sent = yield* server.sent
      const response = sent.find((f: any) => f.toolResponse !== undefined) as any
      // The name comes from the call, and the payload has to be an object.
      expect(response.toolResponse.functionResponses).toEqual([
        { id: "fc_1", name: "get_weather", response: { celsius: 32 } },
      ])
    }).pipe(Effect.scoped),
  )

  it.live("rejects a result for a call this session never made", () =>
    Effect.gen(function* () {
      const server = yield* gemini
      const handle = yield* openSession({ ...cfg, webSocket: server.connect })(request)
      const failure = yield* Effect.exit(
        handle.send(
          RealtimeInput.ToolResult({
            output: {
              type: "function_call_output",
              call_id: "fc_unknown",
              output: "{}",
              providerData: undefined,
            },
          }),
        ),
      )

      expect(failure._tag).toBe("Failure")
      expect(JSON.stringify(failure)).toContain("InvalidRequest")
      expect((yield* server.sent).some((f: any) => f.toolResponse !== undefined)).toBe(false)
    }).pipe(Effect.scoped),
  )
})

describe("Gemini live session lifetime", () => {
  it.live("keeps only a resumable handle, and reads the closing warning as a duration", () =>
    Effect.gen(function* () {
      const server = yield* gemini
      const { events, exit } = yield* transcript(server, () =>
        Effect.gen(function* () {
          // Sent while a tool runs: no handle, and the stored one must stand.
          yield* server.push({ sessionResumptionUpdate: { newHandle: "", resumable: false } })
          yield* server.push({ sessionResumptionUpdate: { newHandle: "h1", resumable: true } })
          yield* server.push({ goAway: { timeLeft: "60s" } })
        }),
      )

      expect(tags(events)).toEqual(["ResumptionHandle", "SessionEnding"])
      const handle = events[0]
      expect(handle?._tag === "ResumptionHandle" && handle.handle).toBe("h1")
      const ending = events[1]
      // A proto duration string, not a number.
      expect(ending?._tag === "SessionEnding" && ending.timeLeft).toEqual(Duration.seconds(60))
      // The close `goAway` announced is the lifetime cap, not a clean end, so
      // a caller can tell "reconnect" from "we are done here".
      expect(JSON.stringify(exit)).toContain("SessionExpired")
    }).pipe(Effect.scoped),
  )

  it.live("ends cleanly when the close was not announced", () =>
    Effect.gen(function* () {
      const server = yield* gemini
      const { exit } = yield* transcript(server, () =>
        server.push({ serverContent: { turnComplete: true } }),
      )

      expect(exit._tag).toBe("Success")
    }).pipe(Effect.scoped),
  )
})

/** The `CapabilityWarning` payloads a run produced, in order. */
const warningCollector = () => {
  const seen: Array<{ readonly field: string; readonly value?: unknown }> = []
  const logger = Logger.make((options) => {
    const [label, warning] = options.message as ReadonlyArray<any>
    if (label === "Capability dropped") seen.push(warning)
  })
  return { seen, layer: Logger.layer([logger]) }
}

const userText = (text: string) =>
  ({
    type: "message",
    role: "user",
    content: [{ type: "input_text", text, providerData: undefined }],
    providerData: undefined,
  }) as const

const call = (id: string) =>
  ({
    type: "function_call",
    call_id: id,
    name: "get_time",
    arguments: "{}",
    providerData: undefined,
  }) as const

describe("Gemini live session history", () => {
  it.live("names each kind of item the text-only seed cannot carry, once", () =>
    Effect.gen(function* () {
      const server = yield* gemini
      const warnings = warningCollector()

      yield* openSession({ ...cfg, webSocket: server.connect })({
        ...request,
        history: [
          userText("what time is it"),
          call("fc_1"),
          call("fc_2"),
          {
            type: "function_call_output",
            call_id: "fc_1",
            output: '{"now":"12:00"}',
            providerData: undefined,
          },
        ],
      }).pipe(Effect.provide(warnings.layer))
      yield* tick

      // Two calls, one kind: a long tool history is not a wall of warnings.
      expect(warnings.seen.map((w) => w.value)).toEqual(["function_call", "function_call_output"])
      expect(warnings.seen.every((w) => w.field === "history")).toBe(true)

      const sent = yield* server.sent
      const seed = sent.find((f: any) => f.clientContent !== undefined) as any
      expect(seed.clientContent.turns).toEqual([
        { role: "user", parts: [{ text: "what time is it" }] },
      ])
    }).pipe(Effect.scoped),
  )
})

describe("Gemini live session video", () => {
  it.live("sends frame bytes inline, and refuses a frame it would have to fetch", () =>
    Effect.gen(function* () {
      const server = yield* gemini
      yield* transcript(server, (handle) =>
        Effect.gen(function* () {
          yield* handle.send(
            RealtimeInput.VideoFrame({
              frame: { _tag: "bytes", bytes: new Uint8Array([1, 2]), mimeType: "image/jpeg" },
            }),
          )
          // A URL would need an upload through the Files API first.
          const exit = yield* Effect.exit(
            handle.send(
              RealtimeInput.VideoFrame({
                frame: { _tag: "url", url: "https://example.com/frame.jpg" },
              }),
            ),
          )
          expect(JSON.stringify(exit)).toContain("Unsupported")
        }),
      )

      const sent = yield* server.sent
      expect(sent.filter((f: any) => f.realtimeInput?.video !== undefined)).toEqual([
        {
          realtimeInput: {
            video: { data: Encoding.encodeBase64(new Uint8Array([1, 2])), mimeType: "image/jpeg" },
          },
        },
      ])
    }).pipe(Effect.scoped),
  )
})
