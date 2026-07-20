import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Ref,
  Result,
  Schema,
  Stream,
  pipe,
} from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import type { Source } from "@effect-uai/core/Citation"
import {
  DeepResearch,
  type DeepResearchService,
  type DeepResearchServiceShape,
  fromJob,
  type ResearchJobOps,
} from "@effect-uai/core/DeepResearch"
import * as Items from "@effect-uai/core/Items"
import * as Job from "@effect-uai/core/Job"
import type { ResearchJobRef, ResearchRequest, ResearchState } from "@effect-uai/core/Research"
import * as SSE from "@effect-uai/core/SSE"
import { type Turn, TurnEvent } from "@effect-uai/core/Turn"
import { GroundingMetadata, groundingToAnnotations } from "./codec.js"
import type { GoogleDeepResearchModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Gemini-typed research request. Narrows `model` to the deep-research agent ids.
 * Provider-portable code uses the generic `DeepResearch` tag instead.
 */
export type GoogleResearchRequest = Omit<ResearchRequest, "model"> & {
  readonly model?: GoogleDeepResearchModel
}

export type GoogleDeepResearchService = DeepResearchServiceShape<GoogleResearchRequest>

/**
 * Provider-typed tag for Gemini deep research over the Interactions API
 * (`POST /v1beta/interactions`, `agent: deep-research-*`). Yield this for the
 * agent-id knob; yield the generic `DeepResearch` tag for portable code.
 *
 * `research` / `submit` / `collect` drive a background job by polling;
 * `researchStream` consumes the real Interactions SSE (`step.delta` text /
 * thought, terminating in `interaction.completed`). Preview surface: the SSE
 * event shapes and the completed-interaction citation shape are decoded
 * defensively and best confirmed against a live response.
 */
export class GoogleDeepResearch extends Context.Service<
  GoogleDeepResearch,
  GoogleDeepResearchService
>()("@betalyra/effect-uai/providers/google/GoogleDeepResearch") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  /** Poll cadence / overall timeout for the derived poll loops. */
  readonly job?: Job.JobConfig
}

// ---------------------------------------------------------------------------
// Wire codec
// ---------------------------------------------------------------------------

const WireSubmit = Schema.Struct({ id: Schema.String })
const decodeSubmit = Schema.decodeUnknownEffect(WireSubmit)

// A completed interaction's text lives at `outputs[].text` (SDK `outputs`) or,
// in some doc examples, `steps[].content[].text`. Decode both defensively and
// extract from whichever is populated. Grounding sources ride Google's
// `groundingMetadata.groundingChunks[]`; this preview surface is undocumented,
// so decode it at every plausible level (interaction / output / step) and map
// whichever is populated onto `url_citation` annotations. The report text also
// carries the sources as an inline `[n]` / `**Sources:**` list.
const WireTextPart = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  groundingMetadata: Schema.optional(Schema.NullOr(GroundingMetadata)),
})
const WireStep = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(Schema.NullOr(Schema.Array(WireTextPart))),
  groundingMetadata: Schema.optional(Schema.NullOr(GroundingMetadata)),
})
export const WireInteraction = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  outputs: Schema.optional(Schema.NullOr(Schema.Array(WireTextPart))),
  steps: Schema.optional(Schema.NullOr(Schema.Array(WireStep))),
  groundingMetadata: Schema.optional(Schema.NullOr(GroundingMetadata)),
  error: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        message: Schema.optional(Schema.NullOr(Schema.String)),
        code: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
})
export type WireInteraction = typeof WireInteraction.Type
const decodeInteraction = Schema.decodeUnknownEffect(WireInteraction)

const textOfParts = (parts: ReadonlyArray<typeof WireTextPart.Type> | null | undefined): string =>
  (parts ?? [])
    .filter((p) => (p.type ?? "text") === "text" && p.text != null)
    .map((p) => p.text)
    .join("")

const reportText = (wire: WireInteraction): string => {
  const fromOutputs = textOfParts(wire.outputs)
  if (fromOutputs.length > 0) return fromOutputs
  const lastStep = (wire.steps ?? []).at(-1)
  const fromStep = textOfParts(lastStep?.content)
  return fromStep.length > 0 ? fromStep : (lastStep?.text ?? "")
}

/**
 * The subset of the domain `Citation.Source` this provider can populate.
 * Declared here rather than derived from the wire schema, so the exported
 * shape is ours and a wire change cannot silently alter it.
 */
const SourceSchema = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.String),
})

/**
 * The research trace: what the model did at each step and which sources it
 * consulted there. The `Turn` keeps only the final report and the deduped
 * union of all sources, so the per-step breakdown lives here or nowhere.
 *
 * Lands on `providerData.gemini`; read it with {@link researchDataOf}.
 */
export const GeminiResearchData = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      sources: Schema.Array(SourceSchema),
    }),
  ),
})
export type GeminiResearchData = typeof GeminiResearchData.Type

const decodeResearchData = Schema.decodeUnknownResult(Schema.Struct({ gemini: GeminiResearchData }))

/** Read this provider's data off an item, if it is there and ours. */
export const researchDataOf = (item: Items.HistoryItem): Option.Option<GeminiResearchData> =>
  pipe(
    decodeResearchData(item.providerData),
    Result.match({
      onSuccess: (d) => Option.some(d.gemini),
      onFailure: () => Option.none<GeminiResearchData>(),
    }),
  )

const sourcesOf = (meta: GroundingMetadata | null | undefined): ReadonlyArray<Source> =>
  (meta?.groundingChunks ?? []).flatMap((chunk) =>
    chunk.web?.uri == null
      ? []
      : [{ url: chunk.web.uri, ...(chunk.web.title != null && { title: chunk.web.title }) }],
  )

// A step contributes to the trace if it said something or consulted something.
const researchSteps = (wire: WireInteraction): GeminiResearchData["steps"] =>
  (wire.steps ?? []).flatMap((step) => {
    const text = textOfParts(step.content) || (step.text ?? "")
    const sources = [
      ...sourcesOf(step.groundingMetadata),
      ...(step.content ?? []).flatMap((p) => sourcesOf(p.groundingMetadata)),
    ]
    return text.length === 0 && sources.length === 0 ? [] : [{ text, sources }]
  })

// Grounding can live at any level of the interaction envelope; gather it from
// all three (interaction / output part / step) and let `groundingToAnnotations`
// de-dupe by url.
const interactionAnnotations = (wire: WireInteraction): ReadonlyArray<Items.Annotation> =>
  groundingToAnnotations(
    wire.groundingMetadata,
    ...Arr.map(wire.outputs ?? [], (o) => o.groundingMetadata),
    ...Arr.map(wire.steps ?? [], (s) => s.groundingMetadata),
  )

const turnFromInteraction = (wire: WireInteraction): Turn => {
  const annotations = interactionAnnotations(wire)
  return {
    items: [
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: reportText(wire),
            ...(annotations.length > 0 && { annotations }),
          },
        ],
        providerData: { gemini: { steps: researchSteps(wire) } },
      },
    ],
    usage: {},
    stop_reason: "stop",
  }
}

// Map the interaction status onto the generic `JobState`.
export const jobStateOf = (wire: WireInteraction): ResearchState =>
  Match.value(wire.status ?? "").pipe(
    Match.whenOr("queued", "pending", (): ResearchState => ({ _tag: "Pending" })),
    Match.whenOr(
      "in_progress",
      "running",
      "processing",
      (): ResearchState => ({ _tag: "Running" }),
    ),
    Match.whenOr(
      "completed",
      "succeeded",
      (): ResearchState => ({ _tag: "Succeeded", result: turnFromInteraction(wire) }),
    ),
    Match.whenOr(
      "failed",
      "error",
      "cancelled",
      (): ResearchState => ({
        _tag: "Failed",
        ...(wire.error?.message != null && { reason: wire.error.message }),
        raw: wire,
      }),
    ),
    Match.orElse((): ResearchState => ({ _tag: "Running" })),
  )

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const baseUrl = (cfg: Config): string =>
  cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"

const authHeader = (cfg: Config) =>
  HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(cfg.apiKey))

const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "google", raw: cause })

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "google"
  const raw = body
  if (status === 429) return new AiError.RateLimited({ provider, raw })
  if (status === 408 || status === 504) return new AiError.Timeout({ provider, raw })
  if (status === 401) return new AiError.AuthFailed({ provider, subtype: "auth", raw })
  if (status === 403) return new AiError.AuthFailed({ provider, subtype: "permission", raw })
  if (status === 402) return new AiError.AuthFailed({ provider, subtype: "billing", raw })
  if (status === 413) return new AiError.ContextLengthExceeded({ provider, raw })
  if (status >= 500) return new AiError.Unavailable({ provider, status, raw })
  return new AiError.InvalidRequest({ provider, raw })
}

// Deep research takes one question. Concatenate the user turns' text into the
// Interactions `input` string.
const inputText = (history: ReadonlyArray<Items.HistoryItem>): string =>
  history
    .filter(Items.isMessage)
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content)
    .filter(Items.isInputText)
    .map((b) => b.text)
    .join("\n")

const submitBody = (request: GoogleResearchRequest): Record<string, unknown> => ({
  agent: request.model ?? "deep-research-preview-04-2026",
  input: inputText(request.history),
  background: true,
  store: true,
  agent_config: { type: "deep-research", thinking_summaries: "auto" },
  tools: [{ type: "google_search" }],
})

const submitJob = (
  cfg: Config,
  request: GoogleResearchRequest,
): Effect.Effect<ResearchJobRef, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/interactions`).pipe(
      authHeader(cfg),
      HttpClientRequest.bodyJsonUnsafe(submitBody(request)),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    const wire = yield* decodeSubmit(json).pipe(Effect.mapError(transportFailure))
    return Job.jobRef<Turn>("google", wire.id)
  })

const pollJob = (
  cfg: Config,
  ref: ResearchJobRef,
): Effect.Effect<ResearchState, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.get(`${baseUrl(cfg)}/interactions/${ref.id}`).pipe(
      authHeader(cfg),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    // Preview surface: log the raw interaction so the (undocumented) grounding
    // path can be confirmed against a live completed job at LOG_LEVEL=Debug.
    yield* Effect.logDebug("google interactions poll response", { interaction: json })
    const wire = yield* decodeInteraction(json).pipe(Effect.mapError(transportFailure))
    return jobStateOf(wire)
  })

// No verified cancel endpoint on the preview Interactions surface.
const unsupported = (capability: string): AiError.Unsupported =>
  new AiError.Unsupported({
    provider: "google",
    capability,
    reason: "Gemini deep research (preview) exposes no verified cancel endpoint.",
  })

// ---------------------------------------------------------------------------
// Streaming (Interactions SSE)
// ---------------------------------------------------------------------------

// The Interactions stream emits `step.delta` events in two shapes: the report
// body arrives as `delta: { type: "text", text }`, while a thinking summary
// arrives as `delta: { type: "thought_summary", content: { text } }` (and a
// content-free `thought_signature` we skip). Terminates in `interaction.completed`
// / `interaction.error`, then an OpenAI-style `[DONE]` sentinel we drop upstream.
const WireDelta = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        type: Schema.optional(Schema.NullOr(Schema.String)),
        text: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
})
const WireStreamEvent = Schema.Struct({
  event_type: Schema.optional(Schema.NullOr(Schema.String)),
  delta: Schema.optional(Schema.NullOr(WireDelta)),
  interaction: Schema.optional(Schema.NullOr(WireInteraction)),
  error: Schema.optional(
    Schema.NullOr(Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
})
type WireStreamEvent = typeof WireStreamEvent.Type

const parseJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const decodeStreamEvent = Schema.decodeUnknownEffect(WireStreamEvent)

// Prefer the completed interaction's decoded text; when the terminal event is
// bare (or its text decodes empty) fall back to the accumulated stream deltas,
// so `TurnComplete.turn` always carries the report that streamed.
const completedTurn = (wire: WireInteraction | null | undefined, streamed: string): Turn =>
  wire != null && reportText(wire).length > 0
    ? turnFromInteraction(wire)
    : {
        items: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: streamed }],
            ...(wire != null && { providerData: { gemini: { steps: researchSteps(wire) } } }),
          },
        ],
        usage: {},
        stop_reason: "stop",
      }

// Map one wire event onto `TurnEvent`s, appending text deltas to `acc` (the
// `completedTurn` fallback) and lifting `interaction.error` to a typed failure.
const streamEventToTurnEvents = (
  acc: Ref.Ref<string>,
  ev: WireStreamEvent,
): Effect.Effect<ReadonlyArray<TurnEvent>, AiError.AiError> => {
  if (ev.event_type === "interaction.error") {
    return Effect.fail(
      new AiError.GenerationFailed({
        provider: "google",
        ...(ev.error?.message != null && { message: ev.error.message }),
        raw: ev,
      }),
    )
  }
  if (ev.event_type === "step.delta") {
    const delta = ev.delta
    // Report body: `delta.text`. Accumulate it so the terminal `TurnComplete`
    // carries the report even when `interaction.completed` arrives text-free.
    if (delta?.text != null) {
      const text = delta.text
      return Effect.as(
        Ref.update(acc, (streamed) => streamed + text),
        [TurnEvent.TextDelta({ text })],
      )
    }
    // Thinking summary: nested under `delta.content.text`. Surfaced as reasoning,
    // not accumulated into the report.
    if (delta?.content?.text != null) {
      return Effect.succeed([
        TurnEvent.ReasoningDelta({ text: delta.content.text, kind: "summary" }),
      ])
    }
    return Effect.succeed([])
  }
  if (ev.event_type === "interaction.completed") {
    return Effect.map(Ref.get(acc), (streamed) => [
      TurnEvent.TurnComplete({ turn: completedTurn(ev.interaction, streamed) }),
    ])
  }
  return Effect.succeed([])
}

// A streaming interaction create (`?stream=true`): consume the SSE directly,
// mapping each event onto `TurnEvent`s via {@link streamEventToTurnEvents}.
const streamCreate = (
  cfg: Config,
  request: GoogleResearchRequest,
): Stream.Stream<TurnEvent, AiError.AiError, HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const acc = yield* Ref.make("")
      const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/interactions?stream=true`).pipe(
        authHeader(cfg),
        HttpClientRequest.bodyJsonUnsafe({ ...submitBody(request), stream: true }),
        HttpClientRequest.accept("text/event-stream"),
      )
      const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
      // Preview surface: log the response status + content-type so an
      // unexpected `application/json` (i.e. `?stream=true` not triggering SSE)
      // is visible at LOG_LEVEL=Debug rather than presenting as a silent hang.
      yield* Effect.logDebug("google interactions stream response", {
        status: response.status,
        contentType: response.headers["content-type"],
      })
      if (response.status >= 400) {
        const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return Stream.fail(httpStatusError(response.status, text))
      }
      return response.stream.pipe(
        Stream.mapError(transportFailure),
        SSE.fromBytes,
        // Log each raw frame before decode: the ground truth for the (unverified)
        // event_type / delta shapes this codec keys on.
        Stream.tap((ev) =>
          Effect.logDebug("google interactions sse frame", { event: ev.event, data: ev.data }),
        ),
        // The stream ends with an OpenAI-style `[DONE]` sentinel that is not JSON;
        // drop it (and any blank frame) before the JSON decode.
        Stream.filter((ev) => ev.event !== "done" && ev.data.trim() !== "[DONE]"),
        Stream.mapEffect((ev) =>
          parseJsonUnknown(ev.data).pipe(
            Effect.flatMap(decodeStreamEvent),
            Effect.mapError(transportFailure),
            Effect.flatMap((wire) => streamEventToTurnEvents(acc, wire)),
          ),
        ),
        Stream.flatMap(Stream.fromIterable),
      )
    }),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

const jobOps = (
  cfg: Config,
  client: HttpClient.HttpClient,
): ResearchJobOps<GoogleResearchRequest> => {
  const withClient = <A>(e: Effect.Effect<A, AiError.AiError, HttpClient.HttpClient>) =>
    Effect.provideService(e, HttpClient.HttpClient, client)
  return {
    submit: (request) => withClient(submitJob(cfg, request)),
    poll: (ref) => withClient(pollJob(cfg, ref)),
    cancel: () => Effect.fail(unsupported("cancel")),
  }
}

// fromJob's default surface, with `researchStream` overridden to the real
// Interactions SSE (its submit-then-attach default only synthesizes progress).
const buildService = <Req extends ResearchRequest>(
  cfg: Config,
  client: HttpClient.HttpClient,
  ops: ResearchJobOps<Req>,
  toGoogle: (request: Req) => GoogleResearchRequest,
): DeepResearchServiceShape<Req> => ({
  ...fromJob(ops, cfg.job),
  researchStream: (request) =>
    Stream.provideService(streamCreate(cfg, toGoogle(request)), HttpClient.HttpClient, client),
})

/** Build a `GoogleDeepResearchService`. For Layer setup, prefer {@link layer}. */
export const make = (
  cfg: Config,
): Effect.Effect<GoogleDeepResearchService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) =>
    buildService(cfg, client, jobOps(cfg, client), (request) => request),
  )

/**
 * Layer registering the provider-typed `GoogleDeepResearch` tag and the generic
 * `DeepResearch` tag. No capability markers: the surface (poll, collect,
 * synthesized stream) is universal.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<GoogleDeepResearch | DeepResearch, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(GoogleDeepResearch, make(cfg))
  const generic = Layer.effect(
    DeepResearch,
    Effect.map(HttpClient.HttpClient, (client): DeepResearchService => {
      const ops = jobOps(cfg, client)
      const genericOps: ResearchJobOps<ResearchRequest> = {
        ...ops,
        submit: (request) => ops.submit(request as GoogleResearchRequest),
      }
      return buildService(cfg, client, genericOps, (request) => request as GoogleResearchRequest)
    }),
  )
  return Layer.merge(typed, generic)
}
