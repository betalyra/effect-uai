import { Context, Effect, Layer, Match, Option, Redacted, Result, Schema, pipe } from "effect"
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
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import type { ResearchJobRef, ResearchRequest, ResearchState } from "@effect-uai/core/Research"
import type { Turn } from "@effect-uai/core/Turn"
import type { ExaResearchModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Exa-typed research request. Narrows `model` and adds `outputSchema`.
 * Provider-portable code uses the generic `DeepResearch` tag instead.
 */
export type ExaResearchRequest = Omit<ResearchRequest, "model"> & {
  readonly model?: ExaResearchModel
  /**
   * Optional structured output. When set, Exa researches the web and returns
   * JSON matching the schema (Draft 7) instead of a prose report, with
   * field-level citations. The completed `Turn`'s text is that JSON, so decode
   * it with `Turn.decodeStructured(turn, outputSchema)` — the same path as
   * `LanguageModel` structured output.
   */
  readonly outputSchema?: StructuredFormat.StructuredFormat<unknown>
}

export type ExaDeepResearchService = DeepResearchServiceShape<ExaResearchRequest>

/**
 * Provider-typed tag for Exa deep research over the async task API
 * (`POST /research/v0/tasks` create + `GET /research/v0/tasks/{id}` poll). Yield
 * this for the model / `outputSchema` knobs; yield the generic `DeepResearch`
 * tag for portable code. Poll-based, so `researchStream` / `streamFrom` are the
 * synthesized default {@link fromJob} builds.
 */
export class ExaDeepResearch extends Context.Service<ExaDeepResearch, ExaDeepResearchService>()(
  "@betalyra/effect-uai/providers/exa/ExaDeepResearch",
) {}

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

const OptionalText = Schema.optional(Schema.NullOr(Schema.String))

// A source backing one data field. `id` is Exa's dedup key (usually the url).
const WireSource = Schema.Struct({
  id: OptionalText,
  url: OptionalText,
  title: OptionalText,
  snippet: OptionalText,
})

// `data` holds the results: `{ answer }` for a prose task, or the schema-shaped
// object when an `outputSchema` was given. `schema` (non-null) is the reliable
// discriminator. `citations` is keyed by data-field path, each a list of
// sources. Reference: exa-labs/openapi-spec `/research/v0/tasks`.
export const WireResearch = Schema.Struct({
  id: OptionalText,
  status: OptionalText,
  schema: Schema.optional(Schema.NullOr(Schema.Unknown)),
  data: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  citations: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Array(WireSource)))),
  error: Schema.optional(Schema.NullOr(Schema.Struct({ message: OptionalText }))),
})
export type WireResearch = typeof WireResearch.Type
const decodeResearch = Schema.decodeUnknownEffect(WireResearch)

// Structured → the whole `data` object serialized (decoded outside via
// `Turn.decodeStructured`). Prose → `data.answer`.
const reportText = (wire: WireResearch): string => {
  if (wire.schema != null) return JSON.stringify(wire.data ?? {})
  const answer = wire.data?.answer
  return typeof answer === "string" ? answer : ""
}

/**
 * The subset of the domain `Citation.Source` this provider can populate.
 * Declared here rather than derived from the wire schema, so the exported
 * shape is ours and a wire change cannot silently alter it.
 */
const SourceSchema = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.String),
  snippet: Schema.optional(Schema.String),
  raw: Schema.optional(Schema.Unknown),
})

/**
 * Which sources back which field of the result, the one thing the flat
 * `Annotation` view cannot express. Keyed by the data-field path Exa
 * researched, so a structured task can show its provenance per field.
 *
 * Lands on `providerData.exa`; read it with {@link researchDataOf}.
 */
export const ExaResearchData = Schema.Struct({
  sourcesByField: Schema.Record(Schema.String, Schema.Array(SourceSchema)),
})
export type ExaResearchData = typeof ExaResearchData.Type

const decodeResearchData = Schema.decodeUnknownResult(
  Schema.Struct({ exa: ExaResearchData }),
)

/** Read this provider's data off an item, if it is there and ours. */
export const researchDataOf = (item: Items.HistoryItem): Option.Option<ExaResearchData> =>
  pipe(
    decodeResearchData(item.providerData),
    Result.match({
      onSuccess: (d) => Option.some(d.exa),
      onFailure: () => Option.none<ExaResearchData>(),
    }),
  )

const sourcesByField = (wire: WireResearch): Record<string, ReadonlyArray<Source>> =>
  Object.fromEntries(
    Object.entries(wire.citations ?? {}).map(([field, sources]) => [
      field,
      sources.flatMap((s) =>
        s.url == null
          ? []
          : [
              {
                url: s.url,
                ...(s.title != null && { title: s.title }),
                ...(s.snippet != null && { snippet: s.snippet }),
                // Exa's dedup key. `raw` is the domain model's slot for
                // provider-opaque tokens.
                ...(s.id != null && { raw: s.id }),
              },
            ],
      ),
    ]),
  )

// Flatten the field-keyed citations into the flat `Annotation` list. The
// per-field grouping is lost in this view; it stays on `providerData.exa`.
const citationsToAnnotations = (wire: WireResearch): ReadonlyArray<Items.Annotation> =>
  Object.values(wire.citations ?? {})
    .flat()
    .flatMap((c, i) =>
      c.url == null
        ? []
        : [
            {
              type: "url_citation" as const,
              url: c.url,
              title: c.title ?? c.url,
              marker: i + 1,
              ...(c.snippet != null && { cited_text: c.snippet }),
            },
          ],
    )

const turnFromResearch = (wire: WireResearch): Turn => {
  const annotations = citationsToAnnotations(wire)
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
        providerData: { exa: { sourcesByField: sourcesByField(wire) } },
      },
    ],
    usage: {},
    stop_reason: "stop",
  }
}

export const jobStateOf = (wire: WireResearch): ResearchState =>
  Match.value(wire.status ?? "").pipe(
    Match.whenOr("pending", "queued", (): ResearchState => ({ _tag: "Pending" })),
    Match.whenOr("running", "in_progress", (): ResearchState => ({ _tag: "Running" })),
    Match.when(
      "completed",
      (): ResearchState => ({ _tag: "Succeeded", result: turnFromResearch(wire) }),
    ),
    Match.whenOr(
      "failed",
      "canceled",
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

const baseUrl = (cfg: Config): string => cfg.baseUrl ?? "https://api.exa.ai"

const authHeader = (cfg: Config) =>
  HttpClientRequest.setHeader("x-api-key", Redacted.value(cfg.apiKey))

const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "exa", raw: cause })

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "exa"
  const raw = body
  if (status === 429) return new AiError.RateLimited({ provider, raw })
  if (status === 408 || status === 504) return new AiError.Timeout({ provider, raw })
  if (status === 401) return new AiError.AuthFailed({ provider, subtype: "auth", raw })
  if (status === 403) return new AiError.AuthFailed({ provider, subtype: "permission", raw })
  if (status === 402) return new AiError.AuthFailed({ provider, subtype: "billing", raw })
  if (status >= 500) return new AiError.Unavailable({ provider, status, raw })
  return new AiError.InvalidRequest({ provider, raw })
}

// Deep research takes one instruction. Concatenate the user turns' text.
const instructions = (history: ReadonlyArray<Items.HistoryItem>): string =>
  history
    .filter(Items.isMessage)
    .filter((m) => m.role === "user")
    .flatMap((m) => m.content)
    .filter(Items.isInputText)
    .map((b) => b.text)
    .join("\n")

const submitBody = (request: ExaResearchRequest): Record<string, unknown> => ({
  instructions: instructions(request.history),
  model: request.model ?? "exa-research",
  ...(request.outputSchema !== undefined && {
    output: {
      schema: request.outputSchema.schema["~standard"].jsonSchema.input({ target: "draft-07" }),
    },
  }),
})

const submitJob = (
  cfg: Config,
  request: ExaResearchRequest,
): Effect.Effect<ResearchJobRef, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${baseUrl(cfg)}/research/v0/tasks`).pipe(
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
    return Job.jobRef<Turn>("exa", wire.id)
  })

const pollJob = (
  cfg: Config,
  ref: ResearchJobRef,
): Effect.Effect<ResearchState, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.get(`${baseUrl(cfg)}/research/v0/tasks/${ref.id}`).pipe(
      authHeader(cfg),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    const wire = yield* decodeResearch(json).pipe(Effect.mapError(transportFailure))
    return jobStateOf(wire)
  })

const unsupported = (capability: string): AiError.Unsupported =>
  new AiError.Unsupported({
    provider: "exa",
    capability,
    reason: "Exa's research task API exposes no verified cancel endpoint.",
  })

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

const jobOps = (cfg: Config, client: HttpClient.HttpClient): ResearchJobOps<ExaResearchRequest> => {
  const withClient = <A>(e: Effect.Effect<A, AiError.AiError, HttpClient.HttpClient>) =>
    Effect.provideService(e, HttpClient.HttpClient, client)
  return {
    submit: (request) => withClient(submitJob(cfg, request)),
    poll: (ref) => withClient(pollJob(cfg, ref)),
    cancel: () => Effect.fail(unsupported("cancel")),
  }
}

/** Build an `ExaDeepResearchService`. For Layer setup, prefer {@link layer}. */
export const make = (
  cfg: Config,
): Effect.Effect<ExaDeepResearchService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => fromJob(jobOps(cfg, client), cfg.job))

/**
 * Layer registering the provider-typed `ExaDeepResearch` tag and the generic
 * `DeepResearch` tag. No capability markers: the surface (poll, collect,
 * synthesized stream) is universal.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<ExaDeepResearch | DeepResearch, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(ExaDeepResearch, make(cfg))
  const generic = Layer.effect(
    DeepResearch,
    Effect.map(HttpClient.HttpClient, (client): DeepResearchService => {
      const ops = jobOps(cfg, client)
      return fromJob<ResearchRequest>(
        {
          submit: (request) => ops.submit(request as ExaResearchRequest),
          poll: ops.poll,
          cancel: ops.cancel,
        },
        cfg.job,
      )
    }),
  )
  return Layer.merge(typed, generic)
}
