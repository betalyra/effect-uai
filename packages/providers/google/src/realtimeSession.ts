/**
 * Gemini Live speech-to-speech over `BidiGenerateContent`.
 *
 * Auth is a query parameter, so this needs no `ws` package and no headers:
 * the platform `WebSocket` reaches it from Node, Bun, Deno and the browser.
 *
 * Two shapes differ from OpenAI Realtime and drive most of this file. There
 * are no response ids on the wire, so a turn id is minted here and every event
 * of that turn carries it; and there is no truncate op, so a
 * `PlaybackPosition` has nothing to send.
 */
import {
  Cause,
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
import type { AudioFormat } from "@effect-uai/core/Audio"
import * as Capabilities from "@effect-uai/core/Capabilities"
import type { HistoryItem, Usage } from "@effect-uai/core/Items"
import {
  type CommonSessionRequest,
  RealtimeEvent,
  type RealtimeInput,
} from "@effect-uai/core/Realtime"
import type { RealtimeSessionHandle } from "@effect-uai/core/RealtimeSession"
import * as WebSocketSession from "@effect-uai/core/WebSocketSession"
import { parsedResponse, toolDescriptorsToTools } from "./codec.js"
import type { GeminiLiveModel } from "./models.js"

const PROVIDER = "gemini-live"

const DEFAULT_BASE_URL = "wss://generativelanguage.googleapis.com"
const RPC = "ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  /** Build the socket yourself, for a proxy or an in-memory transport. */
  readonly webSocket?: Socket.WebSocketConstructor["Service"]
}

/**
 * Gemini-typed session request. Everything past `CommonSessionRequest` is
 * provider-shaped. The configuration is immutable for the connection: changing
 * any of it means opening a new session.
 */
export type GeminiLiveRequest = Omit<CommonSessionRequest, "model"> & {
  readonly model: GeminiLiveModel
  /** Replaces the plain `turnDetection` switch when you need the knobs. */
  readonly vad?: {
    readonly startSensitivity?: "high" | "low"
    readonly endSensitivity?: "high" | "low"
    readonly prefixPaddingMs?: number
    readonly silenceDurationMs?: number
  }
  /** `"none"` turns barge-in off. Defaults to interrupting. */
  readonly activityHandling?: "interrupt" | "none"
  /**
   * When a tool result reaches the model, for the models that keep generating
   * while a tool runs. Defaults to `"when-idle"`: the server's own default is
   * to interrupt, which cuts off whatever the model was saying while it
   * waited, including the "let me look that up" it just spoke. `"interrupt"`
   * is right when the result cannot wait, `"silent"` when it is context the
   * model should have rather than something to announce.
   */
  readonly toolScheduling?: "when-idle" | "interrupt" | "silent"
  readonly turnCoverage?: "activity" | "all" | "audioActivityAndAllVideo"
  /** 3.1 only. Higher levels delay the first audio. */
  readonly thinkingLevel?: "minimal" | "low" | "medium" | "high"
  readonly mediaResolution?: "low" | "medium" | "high"
  readonly languageCode?: string
  readonly temperature?: number
  readonly maxOutputTokens?: number
  /** What turns an otherwise time-boxed session into an unbounded one. */
  readonly contextCompression?: {
    readonly triggerTokens?: number
    readonly targetTokens?: number
  }
  /** Grounding. Cannot be combined with `tools`; the pair is a 400. */
  readonly googleSearch?: boolean
  /** 2.5 only. */
  readonly proactiveAudio?: boolean
  /** 2.5 only. */
  readonly affectiveDialog?: boolean
}

// ---------------------------------------------------------------------------
// AudioFormat -> wire
// ---------------------------------------------------------------------------

/** Output is 24 kHz whatever the input rate, and cannot be configured. */
const OUTPUT_RATE = 24000

const unsupportedFormat = (format: AudioFormat, field: string, expected: string) =>
  new AiError.Unsupported({
    provider: PROVIDER,
    capability: field,
    reason: `Gemini Live accepts ${expected}. Got ${JSON.stringify(format)}.`,
  })

/** Any rate is accepted on input; 16 kHz is what the model works in. */
const inputRate = (format: AudioFormat): Effect.Effect<number, AiError.AiError> =>
  Match.value(format).pipe(
    Match.when({ container: "raw", encoding: "pcm_s16le", channels: 1 }, (f) =>
      Effect.succeed(f.sampleRate),
    ),
    Match.orElse((f) =>
      Effect.fail(unsupportedFormat(f, "inputFormat", "mono pcm_s16le at any rate")),
    ),
  )

const checkOutputFormat = (format: AudioFormat): Effect.Effect<void, AiError.AiError> =>
  Match.value(format).pipe(
    Match.when(
      { container: "raw", encoding: "pcm_s16le", sampleRate: OUTPUT_RATE, channels: 1 },
      () => Effect.void,
    ),
    Match.orElse((f) =>
      Effect.fail(unsupportedFormat(f, "outputFormat", `mono pcm_s16le at ${OUTPUT_RATE}`)),
    ),
  )

// ---------------------------------------------------------------------------
// Client frames
// ---------------------------------------------------------------------------

const SENSITIVITY = { high: "HIGH", low: "LOW" } as const

const TURN_COVERAGE = {
  activity: "TURN_INCLUDES_ONLY_ACTIVITY",
  all: "TURN_INCLUDES_ALL_INPUT",
  audioActivityAndAllVideo: "TURN_INCLUDES_AUDIO_ACTIVITY_AND_ALL_VIDEO",
} as const

const realtimeInputConfig = (request: GeminiLiveRequest) => ({
  automaticActivityDetection: {
    ...(request.turnDetection === "manual" && { disabled: true }),
    ...(request.vad?.startSensitivity !== undefined && {
      startOfSpeechSensitivity: `START_SENSITIVITY_${SENSITIVITY[request.vad.startSensitivity]}`,
    }),
    ...(request.vad?.endSensitivity !== undefined && {
      endOfSpeechSensitivity: `END_SENSITIVITY_${SENSITIVITY[request.vad.endSensitivity]}`,
    }),
    ...(request.vad?.prefixPaddingMs !== undefined && {
      prefixPaddingMs: request.vad.prefixPaddingMs,
    }),
    ...(request.vad?.silenceDurationMs !== undefined && {
      silenceDurationMs: request.vad.silenceDurationMs,
    }),
  },
  ...(request.activityHandling !== undefined && {
    activityHandling:
      request.activityHandling === "none" ? "NO_INTERRUPTION" : "START_OF_ACTIVITY_INTERRUPTS",
  }),
  ...(request.turnCoverage !== undefined && { turnCoverage: TURN_COVERAGE[request.turnCoverage] }),
})

const generationConfig = (request: GeminiLiveRequest) => ({
  responseModalities: ["AUDIO"],
  ...(request.voiceId !== undefined && {
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: request.voiceId } },
      ...(request.languageCode !== undefined && { languageCode: request.languageCode }),
    },
  }),
  ...(request.temperature !== undefined && { temperature: request.temperature }),
  ...(request.maxOutputTokens !== undefined && { maxOutputTokens: request.maxOutputTokens }),
  ...(request.mediaResolution !== undefined && {
    mediaResolution: `MEDIA_RESOLUTION_${request.mediaResolution.toUpperCase()}`,
  }),
  ...(request.thinkingLevel !== undefined && {
    thinkingConfig: { thinkingLevel: request.thinkingLevel.toUpperCase() },
  }),
  ...(request.affectiveDialog === true && { enableAffectiveDialog: true }),
})

const toolsOf = (request: GeminiLiveRequest) =>
  request.googleSearch === true
    ? [{ googleSearch: {} }]
    : toolDescriptorsToTools(request.tools ?? [])

const setupFrame = (request: GeminiLiveRequest): string => {
  const tools = toolsOf(request)
  return JSON.stringify({
    setup: {
      model: `models/${request.model}`,
      generationConfig: generationConfig(request),
      ...(request.instructions !== undefined && {
        systemInstruction: { parts: [{ text: request.instructions }] },
      }),
      ...(tools.length > 0 && { tools }),
      realtimeInputConfig: realtimeInputConfig(request),
      ...(request.transcribeInput !== false && { inputAudioTranscription: {} }),
      // The only way to text on a native-audio model.
      outputAudioTranscription: {},
      // Always on, so a handle exists before the ten-minute socket ends.
      sessionResumption: request.resume === undefined ? {} : { handle: request.resume },
      ...(request.contextCompression !== undefined && {
        contextWindowCompression: {
          slidingWindow: {
            ...(request.contextCompression.targetTokens !== undefined && {
              targetTokens: request.contextCompression.targetTokens,
            }),
          },
          ...(request.contextCompression.triggerTokens !== undefined && {
            triggerTokens: request.contextCompression.triggerTokens,
          }),
        },
      }),
      ...(request.proactiveAudio === true && { proactivity: { proactiveAudio: true } }),
      // Seeded history arrives as `clientContent` right after the handshake.
      ...((request.history?.length ?? 0) > 0 && {
        historyConfig: { initialHistoryInClientContent: true },
      }),
    },
  })
}

const messageText = (item: HistoryItem): string =>
  item.type !== "message"
    ? ""
    : item.content
        .map((block) =>
          block.type === "input_text" || block.type === "output_text" ? block.text : "",
        )
        .join("")

/**
 * Text-only seed, which is all `history` promises across providers. Anything
 * with no text of its own, a tool call or its output, has no place in the seed
 * and is reported once per kind rather than vanishing.
 */
const historyFrame = (
  history: ReadonlyArray<HistoryItem>,
): Effect.Effect<string, AiError.AiError> =>
  Effect.gen(function* () {
    const kinds = new Set(history.filter((i) => messageText(i).length === 0).map((i) => i.type))
    yield* Effect.forEach(
      kinds,
      (kind) =>
        Capabilities.warnDropped({
          provider: PROVIDER,
          capability: "history",
          field: "history",
          value: kind,
          reason: `Gemini Live seeds a session with text turns only, so \`${kind}\` items are left out.`,
        }),
      { discard: true },
    )
    return JSON.stringify({
      clientContent: {
        turns: history
          .filter((item) => messageText(item).length > 0)
          .map((item) => ({
            role: item.type === "message" && item.role === "assistant" ? "model" : "user",
            parts: [{ text: messageText(item) }],
          })),
        turnComplete: true,
      },
    })
  })

// ---------------------------------------------------------------------------
// Server frames
//
// Gemini has no discriminator field: one message carries exactly one of these
// keys, and `serverContent` can carry several of its own at once.
// ---------------------------------------------------------------------------

const Part = Schema.Struct({
  text: Schema.optional(Schema.String),
  thought: Schema.optional(Schema.Boolean),
  inlineData: Schema.optional(
    Schema.Struct({
      mimeType: Schema.optional(Schema.String),
      data: Schema.optional(Schema.String),
    }),
  ),
})

const Transcription = Schema.Struct({ text: Schema.optional(Schema.String) })

const ServerContent = Schema.Struct({
  modelTurn: Schema.optional(Schema.Struct({ parts: Schema.optional(Schema.Array(Part)) })),
  turnComplete: Schema.optional(Schema.Boolean),
  generationComplete: Schema.optional(Schema.Boolean),
  interrupted: Schema.optional(Schema.Boolean),
  inputTranscription: Schema.optional(Transcription),
  interimInputTranscription: Schema.optional(Transcription),
  outputTranscription: Schema.optional(Transcription),
})

const UsageMetadata = Schema.Struct({
  promptTokenCount: Schema.optional(Schema.Number),
  responseTokenCount: Schema.optional(Schema.Number),
  totalTokenCount: Schema.optional(Schema.Number),
})

const FunctionCall = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  args: Schema.optional(Schema.Unknown),
})

const ServerMessage = Schema.Struct({
  setupComplete: Schema.optional(Schema.Unknown),
  serverContent: Schema.optional(ServerContent),
  toolCall: Schema.optional(
    Schema.Struct({ functionCalls: Schema.optional(Schema.Array(FunctionCall)) }),
  ),
  toolCallCancellation: Schema.optional(
    Schema.Struct({ ids: Schema.optional(Schema.Array(Schema.String)) }),
  ),
  goAway: Schema.optional(Schema.Struct({ timeLeft: Schema.optional(Schema.String) })),
  sessionResumptionUpdate: Schema.optional(
    Schema.Struct({
      newHandle: Schema.optional(Schema.String),
      resumable: Schema.optional(Schema.Boolean),
    }),
  ),
  usageMetadata: Schema.optional(UsageMetadata),
})

type ServerMessage = typeof ServerMessage.Type

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

type SessionState = {
  /** The turn now generating, if any. Minted here: the wire has no id. */
  readonly responseId: string | undefined
  readonly turns: number
  /** Call id to tool name, since `functionResponse` must repeat the name. */
  readonly callNames: Readonly<Record<string, string>>
  /** Latest `usageMetadata`, reported with the turn it lands in. */
  readonly usage: Usage | undefined
  /** The server has announced the close, so the next one is the lifetime cap. */
  readonly goingAway: boolean
}

const initialState: SessionState = {
  responseId: undefined,
  turns: 0,
  callNames: {},
  usage: undefined,
  goingAway: false,
}

/**
 * The id every event of the current turn carries, minting one and announcing
 * the turn if this is its first event.
 */
const startTurn = (
  state: Ref.Ref<SessionState>,
): Effect.Effect<readonly [string, ReadonlyArray<RealtimeEvent>]> =>
  Ref.modify(state, (s) => {
    const responseId = s.responseId ?? `turn_${s.turns + 1}`
    return s.responseId !== undefined
      ? [[responseId, []], s]
      : [
          [responseId, [RealtimeEvent.ResponseStarted({ responseId })]],
          { ...s, responseId, turns: s.turns + 1 },
        ]
  })

const usageOf = (metadata: typeof UsageMetadata.Type): Usage => ({
  ...(metadata.promptTokenCount !== undefined && { input_tokens: metadata.promptTokenCount }),
  ...(metadata.responseTokenCount !== undefined && { output_tokens: metadata.responseTokenCount }),
  ...(metadata.totalTokenCount !== undefined && { total_tokens: metadata.totalTokenCount }),
})

const decodeAudio = (b64: string): Effect.Effect<Uint8Array, AiError.AiError> =>
  Result.match(Encoding.decodeBase64(b64), {
    onSuccess: Effect.succeed,
    onFailure: (cause) =>
      Effect.fail(
        new AiError.GenerationFailed({
          provider: PROVIDER,
          raw: { message: "audio part base64 decode failed", cause },
        }),
      ),
  })

/** `timeLeft` is a proto duration, so `"60s"` rather than a number. */
const parseTimeLeft = (timeLeft: string | undefined): Duration.Duration | undefined => {
  if (timeLeft === undefined) return undefined
  const seconds = Number.parseFloat(timeLeft.replace(/s$/, ""))
  return Number.isFinite(seconds) ? Duration.seconds(seconds) : undefined
}

/** Thought parts are the model reasoning, not something to speak or show. */
const partToEvents = (
  responseId: string,
  part: typeof Part.Type,
): Effect.Effect<ReadonlyArray<RealtimeEvent>, AiError.AiError> =>
  Match.value(part).pipe(
    Match.when({ thought: true }, () => Effect.succeed([])),
    Match.when({ inlineData: { data: Match.string } }, (p) =>
      Effect.map(decodeAudio(p.inlineData.data), (bytes) => [
        RealtimeEvent.AudioDelta({ responseId, bytes }),
      ]),
    ),
    Match.when({ text: Match.string }, (p) =>
      Effect.succeed([RealtimeEvent.OutputTranscriptDelta({ responseId, text: p.text })]),
    ),
    Match.orElse(() => Effect.succeed([])),
  )

const inputTranscripts = (content: typeof ServerContent.Type): ReadonlyArray<RealtimeEvent> => [
  ...(content.interimInputTranscription?.text === undefined
    ? []
    : [
        RealtimeEvent.InputTranscript({
          text: content.interimInputTranscription.text,
          final: false,
        }),
      ]),
  ...(content.inputTranscription?.text === undefined
    ? []
    : [RealtimeEvent.InputTranscript({ text: content.inputTranscription.text, final: true })]),
]

/**
 * One `serverContent` to its events. Several fields can arrive together, and
 * 3.1 packs several parts into one message, so this answers with a batch.
 */
const contentToEvents = (
  state: Ref.Ref<SessionState>,
  content: typeof ServerContent.Type,
): Effect.Effect<ReadonlyArray<RealtimeEvent>, AiError.AiError> =>
  Effect.gen(function* () {
    // The user's own words belong to no turn, so they need none started.
    const input = inputTranscripts(content)
    const parts = content.modelTurn?.parts ?? []
    const spokenText = content.outputTranscription?.text
    const generating = parts.length > 0 || spokenText !== undefined
    const ending = content.interrupted === true || content.turnComplete === true
    if (!generating && !ending) return input

    const [responseId, started] = generating
      ? yield* startTurn(state)
      : [(yield* Ref.get(state)).responseId, [] as ReadonlyArray<RealtimeEvent>]
    // A terminal flag for a turn that already ended is nothing to report.
    if (responseId === undefined) return input

    const spoken = yield* Effect.forEach(parts, (part) => partToEvents(responseId, part))
    const transcript =
      spokenText === undefined
        ? []
        : [RealtimeEvent.OutputTranscriptDelta({ responseId, text: spokenText })]
    const body = [...input, ...started, ...spoken.flat(), ...transcript]
    if (!ending) return body

    const usage = (yield* Ref.get(state)).usage
    yield* Ref.update(state, (s) => ({ ...s, responseId: undefined, usage: undefined }))
    return [
      ...body,
      // Playback must stop before the turn is reported as over.
      ...(content.interrupted === true ? [RealtimeEvent.Interrupted({ responseId })] : []),
      RealtimeEvent.ResponseDone({
        responseId,
        reason: content.interrupted === true ? "interrupted" : "complete",
        ...(usage !== undefined && { usage }),
      }),
    ]
  })

const toolCallEvents = (
  state: Ref.Ref<SessionState>,
  calls: ReadonlyArray<typeof FunctionCall.Type>,
): Effect.Effect<ReadonlyArray<RealtimeEvent>> =>
  Effect.gen(function* () {
    const [responseId, started] = yield* startTurn(state)
    yield* Ref.update(state, (s) => ({
      ...s,
      callNames: calls.reduce(
        (names, call) => ({ ...names, [call.id ?? call.name]: call.name }),
        s.callNames,
      ),
    }))
    return [
      ...started,
      ...calls.map((call) =>
        RealtimeEvent.ToolCall({
          responseId,
          call: {
            type: "function_call" as const,
            call_id: call.id ?? call.name,
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
            providerData: undefined,
          },
        }),
      ),
    ]
  })

const toEvents = (
  state: Ref.Ref<SessionState>,
  frame: ServerMessage,
): Effect.Effect<ReadonlyArray<RealtimeEvent>, AiError.AiError> =>
  Effect.gen(function* () {
    if (frame.usageMetadata !== undefined) {
      const usage = usageOf(frame.usageMetadata)
      yield* Ref.update(state, (s) => ({ ...s, usage }))
    }
    if (frame.serverContent !== undefined) return yield* contentToEvents(state, frame.serverContent)
    if (frame.toolCall !== undefined) {
      return yield* toolCallEvents(state, frame.toolCall.functionCalls ?? [])
    }
    const callIds = frame.toolCallCancellation?.ids ?? []
    if (callIds.length > 0) return [RealtimeEvent.ToolCallCancelled({ callIds })]
    if (frame.goAway !== undefined) {
      const timeLeft = parseTimeLeft(frame.goAway.timeLeft)
      yield* Ref.update(state, (s) => ({ ...s, goingAway: true }))
      return [RealtimeEvent.SessionEnding({ ...(timeLeft !== undefined && { timeLeft }) })]
    }
    // An unresumable update carries an empty handle; it must not replace one.
    const handle = frame.sessionResumptionUpdate?.newHandle
    return frame.sessionResumptionUpdate?.resumable === true &&
      handle !== undefined &&
      handle !== ""
      ? [RealtimeEvent.ResumptionHandle({ handle })]
      : []
  })

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

const droppedActivity = (field: string) =>
  Capabilities.warnDropped({
    provider: PROVIDER,
    capability: "manualTurns",
    field,
    reason: "The session uses automatic activity detection; boundaries are the server's.",
  })

const videoPart = (
  frame: Extract<RealtimeInput, { readonly _tag: "VideoFrame" }>["frame"],
): Effect.Effect<{ readonly data: string; readonly mimeType: string }, AiError.AiError> =>
  Match.value(frame).pipe(
    Match.tag("base64", (s) => Effect.succeed({ data: s.base64, mimeType: s.mimeType })),
    Match.tag("bytes", (s) =>
      Effect.succeed({ data: Encoding.encodeBase64(s.bytes), mimeType: s.mimeType }),
    ),
    Match.tag("url", () =>
      Effect.fail(
        new AiError.Unsupported({
          provider: PROVIDER,
          capability: "videoInput",
          reason: "A live video frame must carry its bytes; a URL would need the Files API.",
        }),
      ),
    ),
    Match.exhaustive,
  )

/** Wire spelling of `toolScheduling`. */
type ToolScheduling = "WHEN_IDLE" | "INTERRUPT" | "SILENT"

const schedulingOf = (request: GeminiLiveRequest): ToolScheduling =>
  Match.value(request.toolScheduling ?? "when-idle").pipe(
    Match.when("when-idle", () => "WHEN_IDLE" as const),
    Match.when("interrupt", () => "INTERRUPT" as const),
    Match.when("silent", () => "SILENT" as const),
    Match.exhaustive,
  )

const handleInput = (
  send: (frame: string) => Effect.Effect<void, AiError.AiError>,
  state: Ref.Ref<SessionState>,
  options: {
    readonly manual: boolean
    readonly rate: number
    readonly scheduling: ToolScheduling
  },
  input: RealtimeInput,
): Effect.Effect<void, AiError.AiError> =>
  Match.value(input).pipe(
    Match.tag("Audio", (i) =>
      send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              data: Encoding.encodeBase64(i.bytes),
              mimeType: `audio/pcm;rate=${options.rate}`,
            },
          },
        }),
      ),
    ),
    Match.tag("Text", (i) =>
      i.role === "system"
        ? Effect.fail(
            new AiError.Unsupported({
              provider: PROVIDER,
              capability: "systemTurn",
              reason: "Gemini Live fixes the system instruction at setup for the connection.",
            }),
          )
        : send(JSON.stringify({ realtimeInput: { text: i.text } })),
    ),
    Match.tag("ToolResult", (i) =>
      Effect.gen(function* () {
        const name = (yield* Ref.get(state)).callNames[i.output.call_id]
        if (name === undefined) {
          return yield* Effect.fail(
            new AiError.InvalidRequest({
              provider: PROVIDER,
              raw: `no tool call ${i.output.call_id} in this session`,
            }),
          )
        }
        // Answering resumes generation on its own; there is no turn to ask
        // for. `scheduling` says when, and matters on a model that kept
        // generating while the tool ran.
        yield* send(
          JSON.stringify({
            toolResponse: {
              functionResponses: [
                {
                  id: i.output.call_id,
                  name,
                  response: parsedResponse(i.output.output),
                  scheduling: options.scheduling,
                },
              ],
            },
          }),
        )
      }),
    ),
    Match.tag("Interrupt", () =>
      Effect.fail(
        new AiError.Unsupported({
          provider: PROVIDER,
          capability: "interrupt",
          reason:
            'Gemini Live has no cancel op: the server interrupts when it hears speech. Pass activityHandling: "none" to turn that off.',
        }),
      ),
    ),
    Match.tag("VideoFrame", (i) =>
      Effect.flatMap(videoPart(i.frame), (video) =>
        send(JSON.stringify({ realtimeInput: { video } })),
      ),
    ),
    Match.tag("ActivityStart", () =>
      options.manual
        ? send(JSON.stringify({ realtimeInput: { activityStart: {} } }))
        : droppedActivity("ActivityStart"),
    ),
    Match.tag("ActivityEnd", () =>
      options.manual
        ? send(JSON.stringify({ realtimeInput: { activityEnd: {} } }))
        : droppedActivity("ActivityEnd"),
    ),
    // Interruption already drops what was never generated, but audio the
    // server did send stays in history whether or not it was heard.
    Match.tag("PlaybackPosition", () =>
      Capabilities.warnDropped({
        provider: PROVIDER,
        capability: "truncate",
        field: "PlaybackPosition",
        reason: "Gemini Live has no truncate op, so the unheard tail stays in context.",
      }),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export const buildWsUrl = (cfg: Config): string => {
  const url = new URL(cfg.baseUrl ?? DEFAULT_BASE_URL)
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:"
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${RPC}`
  url.searchParams.set("key", Redacted.value(cfg.apiKey))
  return url.toString()
}

const withSocket =
  (cfg: Config) =>
  <A, E, R>(
    effect: Effect.Effect<A, E, R | Socket.WebSocketConstructor>,
  ): Effect.Effect<A, E, Exclude<R, Socket.WebSocketConstructor>> =>
    cfg.webSocket === undefined
      ? Effect.provide(effect, Socket.layerWebSocketConstructorGlobal)
      : Effect.provideService(effect, Socket.WebSocketConstructor, cfg.webSocket)

/** Drop frames until `setupComplete`; a close before it is a failed handshake. */
const awaitSetupComplete = (
  session: WebSocketSession.WebSocketSession<ServerMessage>,
): Effect.Effect<void, AiError.AiError> =>
  Queue.take(session.frames).pipe(
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
      frame.setupComplete === undefined ? awaitSetupComplete(session) : Effect.void,
    ),
  )

export const openSession =
  (cfg: Config) =>
  (
    request: GeminiLiveRequest,
  ): Effect.Effect<RealtimeSessionHandle, AiError.AiError, Scope.Scope> =>
    Effect.gen(function* () {
      if (request.googleSearch === true && (request.tools?.length ?? 0) > 0) {
        return yield* Effect.fail(
          new AiError.InvalidRequest({
            provider: PROVIDER,
            raw: "Gemini rejects googleSearch alongside function declarations; pick one per session.",
          }),
        )
      }
      const rate = yield* inputRate(request.inputFormat)
      const scheduling = schedulingOf(request)
      yield* checkOutputFormat(request.outputFormat)

      const session = yield* WebSocketSession.open({
        url: buildWsUrl(cfg),
        provider: PROVIDER,
        schema: ServerMessage,
        openTimeout: Duration.seconds(30),
      }).pipe(withSocket(cfg))

      // The client speaks first here, and nothing else may be sent until the
      // server has accepted the configuration.
      yield* session.send(setupFrame(request))
      yield* awaitSetupComplete(session)

      const history = request.history ?? []
      if (history.length > 0) {
        const seed = yield* historyFrame(history)
        yield* session.send(seed)
      }

      const state = yield* Ref.make(initialState)
      const out = yield* Queue.bounded<RealtimeEvent, AiError.AiError | Cause.Done>(128)

      const pump = Stream.fromQueue(session.frames).pipe(
        Stream.mapEffect((frame) => toEvents(state, frame)),
        Stream.runForEach((events) => Queue.offerAll(out, events)),
      )

      // A close never synthesizes a `ResponseDone`; a turn still in flight
      // ends the stream as an incomplete turn instead.
      const finish = (cause: Cause.Cause<AiError.AiError> | undefined) =>
        Effect.gen(function* () {
          const { goingAway, responseId } = yield* Ref.get(state)
          if (responseId !== undefined) {
            return yield* Queue.fail(
              out,
              new AiError.IncompleteTurn({ raw: cause ?? "the socket closed mid turn" }),
            )
          }
          // `goAway` was the server announcing this close, so the session hit
          // its cap. Reconnecting works; retrying this session does not.
          if (goingAway) {
            return yield* Queue.fail(
              out,
              new AiError.SessionExpired({
                provider: PROVIDER,
                raw: cause ?? "the socket closed after the server announced it was going away",
              }),
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

      const manual = request.turnDetection === "manual"
      return {
        send: (input) => handleInput(session.send, state, { manual, rate, scheduling }, input),
        events: Stream.fromQueue(out),
      }
    })
