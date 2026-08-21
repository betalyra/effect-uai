import { Context, Effect, Layer, Match, Option, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import {
  DeepResearch,
  type DeepResearchService,
  type DeepResearchServiceShape,
  fromJob,
  type ResearchJobOps,
} from "@effect-uai/core/DeepResearch"
import * as Job from "@effect-uai/core/Job"
import type { ResearchJobRef, ResearchRequest, ResearchState } from "@effect-uai/core/Research"
import type { Turn, TurnEvent } from "@effect-uai/core/Turn"
import { WireResponseCompleted, turnFromCompleted, itemsToInput } from "./codec.js"
import type { OpenAIDeepResearchModel } from "./models.js"
import { type OpenAiRegion, resolveHost } from "./region.js"
import { httpStatusError, providerEventsOfResponse, toCanonical } from "./Responses.js"
import type { ProviderEvent } from "./streamEvents.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * OpenAI-typed research request. Narrows `model` to the deep-research ids and
 * adds `maxSearches` (mapped to `max_tool_calls`) and a `reasoning` hint.
 * Provider-portable code uses the generic `DeepResearch` tag instead.
 */
export type OpenAIResearchRequest = Omit<ResearchRequest, "model"> & {
  readonly model?: OpenAIDeepResearchModel
  /** Cost/latency cap on the agent's tool calls. Maps to `max_tool_calls`. */
  readonly maxSearches?: number
  /** Reasoning-effort hint; `summary: "auto"` streams reasoning summaries. */
  readonly reasoning?: {
    readonly effort?: "low" | "medium" | "high"
    readonly summary?: "auto" | "concise" | "detailed"
  }
}

export type OpenAIDeepResearchService = DeepResearchServiceShape<OpenAIResearchRequest>

/**
 * Provider-typed tag. Yield this for the OpenAI model / `maxSearches` knobs;
 * yield the generic `DeepResearch` tag for provider-portable code. The
 * background job is detachable and streams live over the resumable Responses
 * SSE, so `streamFrom` is a real event stream (not the synthesized fallback) and
 * a persisted ref survives a restart.
 */
export class OpenAIDeepResearch extends Context.Service<
  OpenAIDeepResearch,
  OpenAIDeepResearchService
>()("@betalyra/effect-uai/providers/responses/OpenAIDeepResearch") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  readonly region?: OpenAiRegion
  /** Poll cadence / overall timeout for the derived poll loops. */
  readonly job?: Job.JobConfig
}

// ---------------------------------------------------------------------------
// Wire codec
// ---------------------------------------------------------------------------

const decodeResponse = Schema.decodeUnknownEffect(WireResponseCompleted)

// Any early lifecycle event (`response.created` / `response.queued` / ...)
// carries the response object; only its id matters here. These events are not
// in the modeled `ProviderEvent` union, so they arrive as `_unknown`.
const WireCreated = Schema.Struct({ response: Schema.Struct({ id: Schema.String }) })
const decodeCreated = Schema.decodeUnknownEffect(WireCreated)

const responseIdOf = (event: ProviderEvent): Effect.Effect<Option.Option<string>> =>
  event.type === "_unknown"
    ? decodeCreated(event.raw).pipe(
        Effect.map((wire) => Option.some(wire.response.id)),
        Effect.orElseSucceed(() => Option.none<string>()),
      )
    : Effect.succeedNone

// Map a Responses object's `status` onto the generic `JobState`. `completed`
// and `incomplete` both carry a usable turn (incomplete = stopped early with a
// partial answer, same shape); `failed` / `cancelled` are terminal failures.
// An unknown / absent status keeps the loop polling (bounded by the timeout).
export const jobStateOf = (wire: WireResponseCompleted): ResearchState =>
  Match.value(wire.status ?? "").pipe(
    Match.when("queued", (): ResearchState => ({ _tag: "Pending" })),
    Match.when("in_progress", (): ResearchState => ({ _tag: "Running" })),
    Match.whenOr("completed", "incomplete", (): ResearchState => ({
      _tag: "Succeeded",
      result: turnFromCompleted(wire),
    })),
    Match.whenOr("failed", "cancelled", (): ResearchState => ({
      _tag: "Failed",
      ...(wire.error?.message != null && { reason: wire.error.message }),
      raw: wire,
    })),
    Match.orElse((): ResearchState => ({ _tag: "Running" })),
  )

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "responses", raw: cause })

// Deep research requires at least one data-source tool; default to web search.
const submitBody = (request: OpenAIResearchRequest): Record<string, unknown> => ({
  model: request.model ?? "o3-deep-research",
  input: itemsToInput(request.history),
  background: true,
  store: true,
  tools: [{ type: "web_search_preview" }],
  ...(request.maxSearches !== undefined && { max_tool_calls: request.maxSearches }),
  ...(request.reasoning !== undefined && { reasoning: request.reasoning }),
})

// The job is created with `stream: true` on top of `background: true`: OpenAI
// only exposes a resumable event feed on responses *created* streaming, so this
// keeps every submitted ref attachable via `streamFrom`. Only the first SSE
// event is read (for the response id); the connection is then dropped and the
// background job keeps running server-side.
const submitJob = (
  cfg: Config,
  request: OpenAIResearchRequest,
): Effect.Effect<ResearchJobRef, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${resolveHost(cfg)}/responses`).pipe(
      HttpClientRequest.bearerToken(cfg.apiKey),
      HttpClientRequest.accept("text/event-stream"),
      HttpClientRequest.bodyJsonUnsafe({ ...submitBody(request), stream: true }),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    const id = yield* providerEventsOfResponse(response).pipe(
      Stream.mapEffect(responseIdOf),
      Stream.filter(Option.isSome),
      Stream.map((some) => some.value),
      Stream.runHead,
    )
    return yield* Option.match(id, {
      onNone: () =>
        Effect.fail(
          new AiError.GenerationFailed({
            provider: "responses",
            message: "streaming create ended without a response id",
            raw: submitBody(request),
          }),
        ),
      onSome: (value) => Effect.succeed(Job.jobRef<Turn>("responses", value)),
    })
  })

const pollJob = (
  cfg: Config,
  ref: ResearchJobRef,
): Effect.Effect<ResearchState, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.get(`${resolveHost(cfg)}/responses/${ref.id}`).pipe(
      HttpClientRequest.bearerToken(cfg.apiKey),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    const wire = yield* decodeResponse(json).pipe(Effect.mapError(transportFailure))
    return jobStateOf(wire)
  })

const cancelJob = (
  cfg: Config,
  ref: ResearchJobRef,
): Effect.Effect<void, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(
      `${resolveHost(cfg)}/responses/${ref.id}/cancel`,
    ).pipe(HttpClientRequest.bearerToken(cfg.apiKey))
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(response.status, text)
    }
  })

// Attach a live event stream to a detached job via the resumable Responses SSE,
// reusing the shared decode pipeline and the canonical `TurnEvent` projection.
const streamFromRef = (
  cfg: Config,
  ref: ResearchJobRef,
): Stream.Stream<TurnEvent, AiError.AiError, HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const httpRequest = HttpClientRequest.get(
        `${resolveHost(cfg)}/responses/${ref.id}?stream=true`,
      ).pipe(
        HttpClientRequest.bearerToken(cfg.apiKey),
        HttpClientRequest.accept("text/event-stream"),
      )
      const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
      return toCanonical(providerEventsOfResponse(response))
    }),
  )

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

// The job ops. OpenAI streams live over the resumable Responses SSE, so it
// supplies a real `streamFrom` (not the synthesized fallback). Since `submit`
// creates the job streaming, `fromJob`'s default `researchStream`
// (submit-then-attach) streams real events too.
const jobOps = (
  cfg: Config,
  client: HttpClient.HttpClient,
): ResearchJobOps<OpenAIResearchRequest> => {
  const withClient = <A>(e: Effect.Effect<A, AiError.AiError, HttpClient.HttpClient>) =>
    Effect.provideService(e, HttpClient.HttpClient, client)
  const withClientStream = <A>(s: Stream.Stream<A, AiError.AiError, HttpClient.HttpClient>) =>
    Stream.provideService(s, HttpClient.HttpClient, client)
  return {
    submit: (request) => withClient(submitJob(cfg, request)),
    poll: (ref) => withClient(pollJob(cfg, ref)),
    cancel: (ref) => withClient(cancelJob(cfg, ref)),
    streamFrom: (ref) => withClientStream(streamFromRef(cfg, ref)),
  }
}

/** Build an `OpenAIDeepResearchService`. For Layer setup, prefer {@link layer}. */
export const make = (
  cfg: Config,
): Effect.Effect<OpenAIDeepResearchService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => fromJob(jobOps(cfg, client), cfg.job))

/**
 * Layer registering the provider-typed `OpenAIDeepResearch` tag and the generic
 * `DeepResearch` tag. No capability markers: the whole surface (detach, live
 * stream, cancel) is universal.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<OpenAIDeepResearch | DeepResearch, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(OpenAIDeepResearch, make(cfg))
  const generic = Layer.effect(
    DeepResearch,
    Effect.map(HttpClient.HttpClient, (client): DeepResearchService => {
      const ops = jobOps(cfg, client)
      return fromJob<ResearchRequest>(
        { ...ops, submit: (request) => ops.submit(request as OpenAIResearchRequest) },
        cfg.job,
      )
    }),
  )
  return Layer.merge(typed, generic)
}
