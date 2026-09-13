/**
 * OpenAI Realtime speech-to-speech over `wss://api.openai.com/v1/realtime`.
 *
 * The WS upgrade needs an `Authorization: Bearer` header, which the browser
 * `WebSocket` API cannot set, so this module uses the `ws` peer dep. No
 * `OpenAI-Beta` header: that dialect was shut down 2026-05-12.
 */
import {
  Cause,
  Clock,
  DateTime,
  Duration,
  Effect,
  Encoding,
  Match,
  Pull,
  Queue,
  Redacted,
  Ref,
  Result,
  Schema,
  type Scope,
  Stream,
} from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import * as AiError from "@effect-uai/core/AiError"
import * as Capabilities from "@effect-uai/core/Capabilities"
import type { AudioFormat } from "@effect-uai/core/Audio"
import {
  type CommonSessionRequest,
  RealtimeEvent,
  type RealtimeInput,
} from "@effect-uai/core/Realtime"
import type { RealtimeSessionHandle } from "@effect-uai/core/RealtimeSession"
import type { ToolDescriptor } from "@effect-uai/core/Tool"
import * as WebSocketSession from "@effect-uai/core/WebSocketSession"
import { WebSocket as WSWebSocket } from "ws"
import type { OpenAIRealtimeModel } from "./models.js"
import { type OpenAiRegion, resolveHost } from "./region.js"

const PROVIDER = "openai"

/** `baseUrl` plus `headers` are what make a compatible gateway reachable. */
export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  readonly region?: OpenAiRegion
  readonly headers?: Record<string, string>
  /**
   * Build the socket yourself, for a proxy or an in-memory transport. The
   * default attaches the bearer token through the `ws` package.
   */
  readonly webSocket?: Socket.WebSocketConstructor["Service"]
}

/**
 * OpenAI-typed session request. Everything past `CommonSessionRequest` is
 * provider-shaped and has no equivalent on other providers.
 */
export type OpenAIRealtimeRequest = Omit<CommonSessionRequest, "model" | "resume"> & {
  readonly model: OpenAIRealtimeModel
  /** Replaces the plain `turnDetection` switch when you need the knobs. */
  readonly turnDetectionConfig?:
    | {
        readonly type: "server_vad"
        readonly threshold?: number
        readonly prefixPaddingMs?: number
        readonly silenceDurationMs?: number
        readonly idleTimeoutMs?: number
        readonly createResponse?: boolean
        readonly interruptResponse?: boolean
      }
    | {
        readonly type: "semantic_vad"
        readonly eagerness?: "low" | "medium" | "high" | "auto"
        readonly createResponse?: boolean
        readonly interruptResponse?: boolean
      }
  readonly noiseReduction?: "near_field" | "far_field"
  readonly truncation?:
    | "auto"
    | "disabled"
    | { readonly type: "retention_ratio"; readonly retentionRatio: number }
  readonly reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh"
  readonly maxOutputTokens?: number | "inf"
  readonly speed?: number
  /** `["text"]` turns the session into a text-only responder. */
  readonly outputModalities?: ReadonlyArray<"audio" | "text">
  readonly transcriptionModel?: string
}

// ---------------------------------------------------------------------------
// AudioFormat -> `audio.{input,output}.format`
// ---------------------------------------------------------------------------

type WireFormat =
  | { readonly type: "audio/pcm"; readonly rate: 24000 }
  | { readonly type: "audio/pcmu" }
  | { readonly type: "audio/pcma" }

const unsupportedFormat = (format: AudioFormat, field: string) =>
  new AiError.Unsupported({
    provider: PROVIDER,
    capability: field,
    reason: `OpenAI Realtime accepts pcm_s16le @ 24000, pcm_mulaw @ 8000, or pcm_alaw @ 8000 only. Got ${JSON.stringify(format)}.`,
  })

const formatToWire = (
  field: string,
): ((format: AudioFormat) => Effect.Effect<WireFormat, AiError.AiError>) =>
  Match.type<AudioFormat>().pipe(
    Match.when({ container: "raw", encoding: "pcm_s16le", sampleRate: 24000 }, () =>
      Effect.succeed<WireFormat>({ type: "audio/pcm", rate: 24000 }),
    ),
    Match.when({ container: "raw", encoding: "pcm_mulaw", sampleRate: 8000 }, () =>
      Effect.succeed<WireFormat>({ type: "audio/pcmu" }),
    ),
    Match.when({ container: "raw", encoding: "pcm_alaw", sampleRate: 8000 }, () =>
      Effect.succeed<WireFormat>({ type: "audio/pcma" }),
    ),
    Match.orElse((f) => Effect.fail(unsupportedFormat(f, field))),
  )

// ---------------------------------------------------------------------------
// Client frames
// ---------------------------------------------------------------------------

const toolToWire = (tool: ToolDescriptor) => ({
  type: "function",
  name: tool.name,
  description: tool.description,
  parameters: tool.inputSchema,
})

const turnDetectionToWire = (request: OpenAIRealtimeRequest) =>
  Match.value(request.turnDetectionConfig).pipe(
    Match.when({ type: "server_vad" }, (c) => ({
      type: "server_vad" as const,
      ...(c.threshold !== undefined && { threshold: c.threshold }),
      ...(c.prefixPaddingMs !== undefined && { prefix_padding_ms: c.prefixPaddingMs }),
      ...(c.silenceDurationMs !== undefined && { silence_duration_ms: c.silenceDurationMs }),
      ...(c.idleTimeoutMs !== undefined && { idle_timeout_ms: c.idleTimeoutMs }),
      ...(c.createResponse !== undefined && { create_response: c.createResponse }),
      ...(c.interruptResponse !== undefined && { interrupt_response: c.interruptResponse }),
    })),
    Match.when({ type: "semantic_vad" }, (c) => ({
      type: "semantic_vad" as const,
      ...(c.eagerness !== undefined && { eagerness: c.eagerness }),
      ...(c.createResponse !== undefined && { create_response: c.createResponse }),
      ...(c.interruptResponse !== undefined && { interrupt_response: c.interruptResponse }),
    })),
    // No explicit config: `manual` means no turn detection at all.
    Match.orElse(() =>
      request.turnDetection === "manual" ? null : ({ type: "server_vad" } as const),
    ),
  )

const truncationToWire = (truncation: OpenAIRealtimeRequest["truncation"]) =>
  typeof truncation === "object"
    ? { type: "retention_ratio", retention_ratio: truncation.retentionRatio }
    : truncation

const sessionUpdateFrame = (
  request: OpenAIRealtimeRequest,
  formats: { readonly input: WireFormat; readonly output: WireFormat },
): string =>
  JSON.stringify({
    type: "session.update",
    session: {
      type: "realtime",
      ...(request.instructions !== undefined && { instructions: request.instructions }),
      ...(request.outputModalities !== undefined && {
        output_modalities: request.outputModalities,
      }),
      audio: {
        input: {
          format: formats.input,
          turn_detection: turnDetectionToWire(request),
          ...(request.noiseReduction !== undefined && {
            noise_reduction: { type: request.noiseReduction },
          }),
          ...(request.transcribeInput !== false && {
            transcription: { model: request.transcriptionModel ?? "gpt-live-transcribe" },
          }),
        },
        output: {
          format: formats.output,
          ...(request.voiceId !== undefined && { voice: request.voiceId }),
          ...(request.speed !== undefined && { speed: request.speed }),
        },
      },
      ...(request.tools !== undefined && { tools: request.tools.map(toolToWire) }),
      ...(request.truncation !== undefined && {
        truncation: truncationToWire(request.truncation),
      }),
      ...(request.reasoningEffort !== undefined && {
        reasoning: { effort: request.reasoningEffort },
      }),
      ...(request.maxOutputTokens !== undefined && { max_output_tokens: request.maxOutputTokens }),
    },
  })

const historyItemFrame = (item: unknown): string =>
  JSON.stringify({ type: "conversation.item.create", item })

const textItemFrame = (text: string, role: "user" | "system"): string =>
  JSON.stringify({
    type: "conversation.item.create",
    item: { type: "message", role, content: [{ type: "input_text", text }] },
  })

const responseCreateFrame = JSON.stringify({ type: "response.create" })

// ---------------------------------------------------------------------------
// Server frames
// ---------------------------------------------------------------------------

const Session = Schema.Struct({
  id: Schema.optional(Schema.String),
  expires_at: Schema.optional(Schema.Number),
})

const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
})

const Response = Schema.Struct({
  id: Schema.String,
  status: Schema.optional(Schema.String),
  status_details: Schema.optional(
    Schema.NullOr(Schema.Struct({ reason: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
  usage: Schema.optional(Schema.NullOr(Usage)),
})

const OutputItem = Schema.Struct({
  id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  call_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
})

const ServerEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session.created"), session: Session }),
  Schema.Struct({ type: Schema.Literal("session.updated") }),
  Schema.Struct({ type: Schema.Literal("response.created"), response: Response }),
  Schema.Struct({ type: Schema.Literal("response.done"), response: Response }),
  Schema.Struct({
    type: Schema.Literal("response.output_item.added"),
    response_id: Schema.optional(Schema.String),
    item: OutputItem,
  }),
  Schema.Struct({
    type: Schema.Literal("response.output_audio.delta"),
    response_id: Schema.String,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("response.output_audio_transcript.delta"),
    response_id: Schema.String,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("response.output_text.delta"),
    response_id: Schema.String,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("response.function_call_arguments.done"),
    response_id: Schema.optional(Schema.String),
    call_id: Schema.String,
    name: Schema.optional(Schema.String),
    arguments: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("conversation.item.input_audio_transcription.delta"),
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("conversation.item.input_audio_transcription.completed"),
    transcript: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("input_audio_buffer.speech_started") }),
  Schema.Struct({ type: Schema.Literal("input_audio_buffer.speech_stopped") }),
  Schema.Struct({
    type: Schema.Literal("error"),
    error: Schema.Struct({
      type: Schema.optional(Schema.String),
      code: Schema.optional(Schema.NullOr(Schema.String)),
      message: Schema.String,
    }),
  }),
])

type ServerEvent = typeof ServerEvent.Type

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

type SessionState = {
  /** The response currently generating, if any. */
  readonly responseId: string | undefined
  /**
   * The most recent assistant audio item, and the target of a truncate. It
   * outlives its response: the model generates faster than real time, so a
   * listener is often still hearing an answer the server has finished.
   */
  readonly itemId: string | undefined
  /** `call_id` to tool name, so a `.done` frame can name its call. */
  readonly callNames: Readonly<Record<string, string>>
  /** Calls of the current response that have not been answered. */
  readonly pendingCalls: ReadonlyArray<string>
  readonly interrupted: boolean
  /** A tool result landed mid response; ask for its turn once that one ends. */
  readonly resumeWhenIdle: boolean
  /** When the server drops the session. Converted off the wire's Unix seconds. */
  readonly expiresAt: DateTime.Utc | undefined
}

const initialState: SessionState = {
  responseId: undefined,
  itemId: undefined,
  callNames: {},
  pendingCalls: [],
  interrupted: false,
  resumeWhenIdle: false,
  expiresAt: undefined,
}

const doneReason = (
  response: typeof Response.Type,
): "complete" | "interrupted" | "cancelled" | "error" =>
  Match.value(response.status).pipe(
    Match.when("completed", () => "complete" as const),
    Match.when("cancelled", () =>
      response.status_details?.reason === "turn_detected"
        ? ("interrupted" as const)
        : ("cancelled" as const),
    ),
    Match.orElse(() => "error" as const),
  )

const usageOf = (response: typeof Response.Type) =>
  response.usage == null ? undefined : { ...response.usage }

const decodeAudio = (b64: string): Effect.Effect<Uint8Array, AiError.AiError> =>
  Result.match(Encoding.decodeBase64(b64), {
    onSuccess: Effect.succeed,
    onFailure: (cause) =>
      Effect.fail(
        new AiError.GenerationFailed({
          provider: PROVIDER,
          raw: { message: "audio delta base64 decode failed", cause },
        }),
      ),
  })

/**
 * One server frame to the events it produces, updating the response
 * bookkeeping. Takes `send` because finishing a response is also when a
 * deferred follow-up turn becomes legal to ask for.
 */
const toEvents = (
  send: (frame: string) => Effect.Effect<void, AiError.AiError>,
  state: Ref.Ref<SessionState>,
  frame: ServerEvent,
): Effect.Effect<ReadonlyArray<RealtimeEvent>, AiError.AiError> =>
  Match.value(frame).pipe(
    Match.when({ type: "session.created" }, (f) =>
      Ref.update(state, (s) => ({
        ...s,
        expiresAt:
          f.session.expires_at === undefined
            ? undefined
            : DateTime.makeUnsafe(f.session.expires_at * 1000),
      })).pipe(Effect.as([])),
    ),
    Match.when({ type: "session.updated" }, () => Effect.succeed([])),
    Match.when({ type: "response.created" }, (f) =>
      Ref.update(state, (s) => ({
        ...s,
        responseId: f.response.id,
        pendingCalls: [],
        interrupted: false,
      })).pipe(Effect.as([RealtimeEvent.ResponseStarted({ responseId: f.response.id })])),
    ),
    Match.when({ type: "response.output_item.added" }, (f) =>
      Ref.update(state, (s) => ({
        ...s,
        // Only an assistant message can be truncated, so only it is tracked.
        ...(f.item.type === "message" && f.item.id !== undefined && { itemId: f.item.id }),
        ...(f.item.type === "function_call" &&
          f.item.call_id !== undefined && {
            callNames: { ...s.callNames, [f.item.call_id]: f.item.name ?? "" },
            pendingCalls: [...s.pendingCalls, f.item.call_id],
          }),
      })).pipe(Effect.as([])),
    ),
    Match.when({ type: "response.output_audio.delta" }, (f) =>
      Effect.map(decodeAudio(f.delta), (bytes) => [
        RealtimeEvent.AudioDelta({ responseId: f.response_id, bytes }),
      ]),
    ),
    Match.whenOr(
      { type: "response.output_audio_transcript.delta" },
      { type: "response.output_text.delta" },
      (f) =>
        Effect.succeed([
          RealtimeEvent.OutputTranscriptDelta({ responseId: f.response_id, text: f.delta }),
        ]),
    ),
    Match.when({ type: "response.function_call_arguments.done" }, (f) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(state)
        const name = f.name ?? s.callNames[f.call_id] ?? ""
        return [
          RealtimeEvent.ToolCall({
            responseId: f.response_id ?? s.responseId ?? "",
            call: {
              type: "function_call",
              call_id: f.call_id,
              name,
              arguments: f.arguments,
              providerData: undefined,
            },
          }),
        ]
      }),
    ),
    Match.when({ type: "response.done" }, (f) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(state)
        const reason = doneReason(f.response)
        const cancelled = reason === "interrupted" || reason === "cancelled"
        yield* Ref.set(state, {
          ...s,
          responseId: undefined,
          pendingCalls: [],
          interrupted: false,
          resumeWhenIdle: false,
        })
        // A tool answered while this response was running never got its turn.
        if (s.resumeWhenIdle) yield* send(responseCreateFrame)
        const usage = usageOf(f.response)
        return [
          // Calls of a cancelled response will never be answered.
          ...(cancelled && s.pendingCalls.length > 0
            ? [RealtimeEvent.ToolCallCancelled({ callIds: s.pendingCalls })]
            : []),
          RealtimeEvent.ResponseDone({
            responseId: f.response.id,
            reason,
            ...(usage !== undefined && { usage }),
          }),
        ]
      }),
    ),
    Match.when({ type: "input_audio_buffer.speech_started" }, () =>
      Effect.gen(function* () {
        const s = yield* Ref.get(state)
        // Barge-in: the server cancels the response, but the client owns
        // playback and has to stop it now rather than at `response.done`.
        const interrupting = s.responseId !== undefined && !s.interrupted
        if (interrupting) yield* Ref.set(state, { ...s, interrupted: true })
        return [
          RealtimeEvent.SpeechStarted(),
          ...(interrupting ? [RealtimeEvent.Interrupted({ responseId: s.responseId! })] : []),
        ]
      }),
    ),
    Match.when({ type: "input_audio_buffer.speech_stopped" }, () =>
      Effect.succeed([RealtimeEvent.SpeechStopped()]),
    ),
    Match.when({ type: "conversation.item.input_audio_transcription.delta" }, (f) =>
      Effect.succeed([RealtimeEvent.InputTranscript({ text: f.delta, final: false })]),
    ),
    Match.when({ type: "conversation.item.input_audio_transcription.completed" }, (f) =>
      Effect.succeed([RealtimeEvent.InputTranscript({ text: f.transcript, final: true })]),
    ),
    Match.when({ type: "error" }, (f) =>
      Effect.succeed([
        RealtimeEvent.Error({
          ...(f.error.code != null && { code: f.error.code }),
          message: f.error.message,
        }),
      ]),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

const droppedActivity = (field: string) =>
  Capabilities.warnDropped({
    provider: PROVIDER,
    capability: "manualTurns",
    field,
    reason: "The session uses server turn detection; activity boundaries are the server's.",
  })

const handleInput = (
  send: (frame: string) => Effect.Effect<void, AiError.AiError>,
  state: Ref.Ref<SessionState>,
  manual: boolean,
  input: RealtimeInput,
): Effect.Effect<void, AiError.AiError> =>
  Match.value(input).pipe(
    Match.tag("Audio", (i) =>
      send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: Encoding.encodeBase64(i.bytes),
        }),
      ),
    ),
    Match.tag("Text", (i) =>
      Effect.andThen(send(textItemFrame(i.text, i.role ?? "user")), send(responseCreateFrame)),
    ),
    Match.tag("ToolResult", (i) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(state)
        if (!(i.output.call_id in s.callNames)) {
          return yield* Effect.fail(
            new AiError.InvalidRequest({
              provider: PROVIDER,
              raw: `no tool call ${i.output.call_id} in this session`,
            }),
          )
        }
        yield* send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: i.output.call_id,
              output: i.output.output,
            },
          }),
        )
        yield* Ref.update(state, (cur) => ({
          ...cur,
          pendingCalls: cur.pendingCalls.filter((id) => id !== i.output.call_id),
        }))
        // The adapter resumes generation, so the caller never sends this. Only
        // one response may be active at a time, though, and a slow tool often
        // answers after the user has spoken again, so a result that lands mid
        // response waits for that one to finish.
        const current = yield* Ref.get(state)
        yield* current.responseId === undefined
          ? send(responseCreateFrame)
          : Ref.update(state, (cur) => ({ ...cur, resumeWhenIdle: true }))
      }),
    ),
    Match.tag("Interrupt", () => send(JSON.stringify({ type: "response.cancel" }))),
    Match.tag("VideoFrame", () =>
      Effect.fail(
        new AiError.Unsupported({
          provider: PROVIDER,
          capability: "videoInput",
          reason: "OpenAI Realtime takes still images as conversation items, not video frames.",
        }),
      ),
    ),
    Match.tag("ActivityStart", () => (manual ? Effect.void : droppedActivity("ActivityStart"))),
    Match.tag("ActivityEnd", () =>
      manual
        ? Effect.andThen(
            send(JSON.stringify({ type: "input_audio_buffer.commit" })),
            send(responseCreateFrame),
          )
        : droppedActivity("ActivityEnd"),
    ),
    Match.tag("PlaybackPosition", (i) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(state)
        if (s.itemId === undefined) {
          return yield* Capabilities.warnDropped({
            provider: PROVIDER,
            capability: "truncate",
            field: "PlaybackPosition",
            reason: "No assistant audio item is in flight to truncate.",
          })
        }
        yield* send(
          JSON.stringify({
            type: "conversation.item.truncate",
            item_id: s.itemId,
            content_index: 0,
            audio_end_ms: Math.max(0, Math.round(i.playedMs)),
          }),
        )
      }),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/** A query already on `baseUrl`, such as a gateway's API version, is kept. */
export const buildWsUrl = (cfg: Config, model: string): string => {
  const url = new URL(resolveHost(cfg))
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:"
  url.pathname = `${url.pathname.replace(/\/$/, "")}/realtime`
  url.searchParams.set("model", model)
  return url.toString()
}

// Single contained cast: `@types/ws` declares its WebSocket extending Node's
// EventEmitter while `globalThis.WebSocket` extends EventTarget. The surface
// Effect's Socket reads is identical at runtime.
const authedWsConstructor =
  (cfg: Config): Socket.WebSocketConstructor["Service"] =>
  (url) =>
    new WSWebSocket(url, undefined, {
      headers: {
        Authorization: `Bearer ${Redacted.value(cfg.apiKey)}`,
        ...cfg.headers,
      },
    }) as unknown as globalThis.WebSocket

/** Drop frames until the handshake ack arrives, feeding state on the way. */
const awaitAck = (
  session: WebSocketSession.WebSocketSession<ServerEvent>,
  state: Ref.Ref<SessionState>,
  tag: "session.created" | "session.updated",
): Effect.Effect<void, AiError.AiError> =>
  Queue.take(session.frames).pipe(
    // A clean close before the ack is still a failed handshake.
    Effect.catchCause((cause) =>
      Pull.isDoneCause(cause)
        ? Effect.fail(
            new AiError.Unavailable({
              provider: PROVIDER,
              raw: "the socket closed during the handshake",
            }),
          )
        : Effect.failCause(cause as Cause.Cause<AiError.AiError>),
    ),
    Effect.flatMap((frame) =>
      Effect.andThen(
        toEvents(session.send, state, frame),
        frame.type === tag ? Effect.void : awaitAck(session, state, tag),
      ),
    ),
  )

/** 60 seconds of warning before the server's hard session limit. */
const SESSION_ENDING_LEAD = Duration.seconds(60)

const sessionEndingTimer = (
  state: Ref.Ref<SessionState>,
  out: Queue.Queue<RealtimeEvent, AiError.AiError | Cause.Done>,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const expiresAt = (yield* Ref.get(state)).expiresAt
    if (expiresAt === undefined) return
    const now = yield* Clock.currentTimeMillis
    const leadMs = Duration.toMillis(SESSION_ENDING_LEAD)
    const waitMs = DateTime.toEpochMillis(expiresAt) - leadMs - now
    if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs))
    yield* Queue.offer(out, RealtimeEvent.SessionEnding({ timeLeft: SESSION_ENDING_LEAD })).pipe(
      Effect.ignore,
    )
  })

export const openSession =
  (cfg: Config) =>
  (
    request: OpenAIRealtimeRequest,
  ): Effect.Effect<RealtimeSessionHandle, AiError.AiError, Scope.Scope> =>
    Effect.gen(function* () {
      const formats = {
        input: yield* formatToWire("inputFormat")(request.inputFormat),
        output: yield* formatToWire("outputFormat")(request.outputFormat),
      }
      const session = yield* WebSocketSession.open({
        url: buildWsUrl(cfg, request.model),
        provider: PROVIDER,
        schema: ServerEvent,
        openTimeout: Duration.seconds(30),
      }).pipe(
        Effect.provideService(
          Socket.WebSocketConstructor,
          cfg.webSocket ?? authedWsConstructor(cfg),
        ),
      )

      const state = yield* Ref.make(initialState)
      // `open` resolves only once the server has accepted the configuration.
      yield* awaitAck(session, state, "session.created")
      yield* session.send(sessionUpdateFrame(request, formats))
      yield* awaitAck(session, state, "session.updated")

      for (const item of request.history ?? []) {
        const frame = historyItemFrame(item)
        if (frame !== undefined) yield* session.send(frame)
      }

      const out = yield* Queue.bounded<RealtimeEvent, AiError.AiError | Cause.Done>(128)

      const pump = Stream.fromQueue(session.frames).pipe(
        Stream.mapEffect((frame) => toEvents(session.send, state, frame)),
        Stream.runForEach((events) => Queue.offerAll(out, events)),
      )

      // A close never synthesizes a `ResponseDone`; a response still in flight
      // ends the stream as an incomplete turn instead.
      const finish = (cause: Cause.Cause<AiError.AiError> | undefined) =>
        Effect.gen(function* () {
          const inFlight = (yield* Ref.get(state)).responseId
          if (inFlight !== undefined) {
            return yield* Queue.fail(
              out,
              new AiError.IncompleteTurn({ raw: cause ?? "the socket closed mid response" }),
            )
          }
          return yield* cause !== undefined && Cause.hasFails(cause)
            ? Queue.failCause(out, cause)
            : Queue.end(out)
        })

      yield* pump.pipe(
        Effect.matchCauseEffect({ onFailure: finish, onSuccess: () => finish(undefined) }),
        Effect.forkScoped,
      )
      yield* Effect.forkScoped(sessionEndingTimer(state, out))

      const manual = request.turnDetection === "manual"
      return {
        send: (input) => handleInput(session.send, state, manual, input),
        events: Stream.fromQueue(out),
      }
    })
