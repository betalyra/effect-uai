import { Context, Effect, Layer, Match, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import {
  DeepResearch,
  type DeepResearchService,
  type DeepResearchServiceShape,
  fromJob,
  type ResearchJobOps,
} from "@effect-uai/core/DeepResearch"
import type { Annotation, ContentBlock, HistoryItem, Message } from "@effect-uai/core/Items"
import * as Job from "@effect-uai/core/Job"
import type { ResearchJobRef, ResearchRequest, ResearchState } from "@effect-uai/core/Research"
import type { Turn } from "@effect-uai/core/Turn"
import { httpStatusError, transportFailure } from "./http.js"
import type { PerplexityReasoningEffort, PerplexityResearchModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Perplexity-typed research request. Narrows `model` to the sonar research
 * models and adds `reasoningEffort` (a Perplexity knob that also steers how
 * many searches `sonar-deep-research` runs). Provider-portable code uses the
 * generic `DeepResearch` tag instead.
 */
export type PerplexityResearchRequest = Omit<ResearchRequest, "model"> & {
  readonly model?: PerplexityResearchModel
  readonly reasoningEffort?: PerplexityReasoningEffort
}

export type PerplexityDeepResearchService = DeepResearchServiceShape<PerplexityResearchRequest>

/**
 * Provider-typed tag. Yield this for the Perplexity model / `reasoningEffort`
 * knobs; yield the generic `DeepResearch` tag for provider-portable code. The
 * async job is poll-only, so it has no live event stream: `researchStream` /
 * `streamFrom` return the synthesized progress {@link fromJob} builds (a leading
 * search event, then the terminal report). `cancel` fails `Unsupported` (no
 * endpoint). A persisted ref survives a restart (the job is server-backed).
 */
export class PerplexityDeepResearch extends Context.Service<
  PerplexityDeepResearch,
  PerplexityDeepResearchService
>()("@betalyra/effect-uai/providers/perplexity/PerplexityDeepResearch") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
  /** Poll cadence / overall timeout for the derived poll loops. */
  readonly job?: Job.JobConfig
}

// ---------------------------------------------------------------------------
// Wire codec
// ---------------------------------------------------------------------------

const WireSearchResult = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  snippet: Schema.optional(Schema.String),
})

const WireChoice = Schema.Struct({
  message: Schema.optional(
    Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
})

const WireUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
})

const WireCompletion = Schema.Struct({
  choices: Schema.Array(WireChoice),
  search_results: Schema.optional(Schema.Array(WireSearchResult)),
  citations: Schema.optional(Schema.Array(Schema.String)),
  usage: Schema.optional(WireUsage),
})
type WireCompletion = typeof WireCompletion.Type

const WireJob = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals(["CREATED", "IN_PROGRESS", "COMPLETED", "FAILED"]),
  error_message: Schema.optional(Schema.NullOr(Schema.String)),
  response: Schema.optional(Schema.NullOr(WireCompletion)),
})
type WireJob = typeof WireJob.Type

const decodeJob = Schema.decodeUnknownEffect(WireJob)

// Text of a content block; only the two text-bearing kinds contribute.
const blockText = Match.type<ContentBlock>().pipe(
  Match.discriminatorsExhaustive("type")({
    input_text: (b) => b.text,
    output_text: (b) => b.text,
    input_image: () => "",
    output_image: () => "",
    refusal: () => "",
  }),
)

const historyToMessages = (
  history: ReadonlyArray<HistoryItem>,
): ReadonlyArray<{ readonly role: string; readonly content: string }> =>
  history
    .filter((i): i is Message => i.type === "message")
    .map((m) => ({ role: m.role, content: m.content.map(blockText).join("") }))

// Perplexity links answers to sources with positional `[n]` markers, so each
// citation carries a 1-based `marker` (and `cited_text` from the snippet), the
// provider-agnostic representation of that style. Prefer the richer
// `search_results`; fall back to the legacy `citations` URL list.
const citationsOf = (wire: WireCompletion): ReadonlyArray<Annotation> =>
  wire.search_results !== undefined && wire.search_results.length > 0
    ? wire.search_results.map((r, i) => ({
        type: "url_citation" as const,
        url: r.url,
        title: r.title,
        marker: i + 1,
        ...(r.snippet !== undefined && r.snippet !== "" && { cited_text: r.snippet }),
      }))
    : (wire.citations ?? []).map((url, i) => ({
        type: "url_citation" as const,
        url,
        title: url,
        marker: i + 1,
      }))

const completionToTurn = (wire: WireCompletion): Turn => {
  const text = wire.choices[0]?.message?.content ?? ""
  const annotations = citationsOf(wire)
  return {
    items: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text, ...(annotations.length > 0 && { annotations }) }],
      },
    ],
    usage: {
      ...(wire.usage?.prompt_tokens !== undefined && { input_tokens: wire.usage.prompt_tokens }),
      ...(wire.usage?.completion_tokens !== undefined && {
        output_tokens: wire.usage.completion_tokens,
      }),
      ...(wire.usage?.total_tokens !== undefined && { total_tokens: wire.usage.total_tokens }),
    },
    stop_reason: "stop",
  }
}

// Map Perplexity's four job states onto the generic `JobState`, carrying the
// assembled `Turn` on `Succeeded` and the provider message on `Failed`.
const jobStateOf = (wire: WireJob): ResearchState =>
  Match.value(wire.status).pipe(
    Match.when("CREATED", (): ResearchState => ({ _tag: "Pending" })),
    Match.when("IN_PROGRESS", (): ResearchState => ({ _tag: "Running" })),
    Match.when("COMPLETED", (): ResearchState =>
      wire.response != null
        ? { _tag: "Succeeded", result: completionToTurn(wire.response) }
        : { _tag: "Failed", reason: "job completed with no response body", raw: wire },
    ),
    Match.when("FAILED", (): ResearchState => ({
      _tag: "Failed",
      ...(wire.error_message != null && { reason: wire.error_message }),
      raw: wire,
    })),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const baseUrl = (cfg: Config): string => cfg.baseUrl ?? "https://api.perplexity.ai"

const authHeader = (cfg: Config) =>
  HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(cfg.apiKey)}`)

const submitBody = (request: PerplexityResearchRequest): Record<string, unknown> => ({
  request: {
    model: request.model ?? "sonar-deep-research",
    messages: historyToMessages(request.history),
    ...(request.reasoningEffort !== undefined && { reasoning_effort: request.reasoningEffort }),
  },
})

const submitJob = (
  cfg: Config,
  request: PerplexityResearchRequest,
): Effect.Effect<ResearchJobRef, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/v1/async/sonar`).pipe(
      authHeader(cfg),
      HttpClientRequest.bodyJsonUnsafe(submitBody(request)),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    const wire = yield* decodeJob(json).pipe(Effect.mapError(transportFailure))
    return Job.jobRef<Turn>("perplexity", wire.id)
  })

const pollJob = (
  cfg: Config,
  ref: ResearchJobRef,
): Effect.Effect<ResearchState, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.get(`${baseUrl(cfg)}/v1/async/sonar/${ref.id}`).pipe(
      authHeader(cfg),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    const wire = yield* decodeJob(json).pipe(Effect.mapError(transportFailure))
    return jobStateOf(wire)
  })

// Perplexity exposes no cancel endpoint and no event stream on the async job.
const unsupported = (capability: string): AiError.Unsupported =>
  new AiError.Unsupported({
    provider: "perplexity",
    capability,
    reason: "Perplexity's async research job is poll-only and cannot be cancelled.",
  })

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

// The three job ops. Poll-only, so no `streamFrom`: `fromJob` synthesizes one.
const jobOps = (
  cfg: Config,
  client: HttpClient.HttpClient,
): ResearchJobOps<PerplexityResearchRequest> => {
  const withClient = <A>(e: Effect.Effect<A, AiError.AiError, HttpClient.HttpClient>) =>
    Effect.provideService(e, HttpClient.HttpClient, client)
  return {
    submit: (request) => withClient(submitJob(cfg, request)),
    poll: (ref) => withClient(pollJob(cfg, ref)),
    cancel: () => Effect.fail(unsupported("cancel")),
  }
}

/** Build a `PerplexityDeepResearchService`. For Layer setup, prefer {@link layer}. */
export const make = (
  cfg: Config,
): Effect.Effect<PerplexityDeepResearchService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => fromJob(jobOps(cfg, client), cfg.job))

/**
 * Layer registering the provider-typed `PerplexityDeepResearch` tag and the
 * generic `DeepResearch` tag. No capability markers: the whole surface (poll,
 * collect, synthesized stream) is universal.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<PerplexityDeepResearch | DeepResearch, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(PerplexityDeepResearch, make(cfg))
  const generic = Layer.effect(
    DeepResearch,
    Effect.map(HttpClient.HttpClient, (client): DeepResearchService => {
      const ops = jobOps(cfg, client)
      return fromJob<ResearchRequest>(
        {
          submit: (request) => ops.submit(request as PerplexityResearchRequest),
          poll: ops.poll,
          cancel: ops.cancel,
        },
        cfg.job,
      )
    }),
  )
  return Layer.merge(typed, generic)
}
