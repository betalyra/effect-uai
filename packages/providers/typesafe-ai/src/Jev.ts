import { Context, Effect, Layer, Match, type Redacted, Record, Schema, pipe } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Decision from "@effect-uai/core/Decision"
import {
  type CommonDecideRequest,
  type DecideResponse,
  DecisionModel,
  type DecisionModelService,
} from "@effect-uai/core/DecisionModel"
import type { JevModel } from "./models.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Jev reports its own `confidence` alongside the distribution, on Classify
 * and Rate but not on Probability. The formula is undocumented, so it is not
 * on the Common answer; `Decision.confidence` is ours and is defined for
 * every kind.
 */
export type JevAnswerFor<D> = Decision.AnswerFor<D> & ReportedConfidence<D>

/**
 * Intersected rather than branched per kind, so `JevAnswers` stays provably
 * assignable to `Answers`: TypeScript cannot see one deferred conditional as
 * a subtype of another, but an intersection is always assignable to its
 * members.
 */
type ReportedConfidence<D> = D extends { readonly _tag: "Probability" }
  ? unknown
  : { readonly confidence: number }

export type JevAnswers<D extends Decision.Decisions> = {
  readonly [K in keyof D]: JevAnswerFor<D[K]>
}

export type JevDecideResponse<D extends Decision.Decisions> = Omit<DecideResponse<D>, "answers"> & {
  readonly answers: JevAnswers<D>
}

/** Narrows `model` to Jev's roster. */
export type JevDecideRequest<A> = Omit<CommonDecideRequest<A>, "model"> & {
  readonly model: JevModel
}

export type JevService = {
  readonly decide: <A, D extends Decision.Decisions>(
    definition: Decision.Definition<A, D>,
    request: JevDecideRequest<A>,
  ) => Effect.Effect<JevDecideResponse<D>, AiError.AiError>
}

/**
 * Provider-typed service tag. Yield this for Jev's own `confidence`; yield the
 * generic `DecisionModel` tag for provider-portable code. Both are registered
 * by {@link layer}.
 */
export class Jev extends Context.Service<Jev, JevService>()(
  "@betalyra/effect-uai/providers/typesafe-ai/Jev",
) {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec - request body
// ---------------------------------------------------------------------------

type WireQuestion =
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Decision.Labels }
  | {
      readonly type: "score"
      readonly instructions: string
      readonly criteria: ReadonlyArray<string>
    }
  | {
      readonly type: "noul"
      readonly instructions: string
      readonly criteria?: Decision.Boundary
    }

const questionToWire: (decision: Decision.Decision) => WireQuestion =
  Match.type<Decision.Decision>().pipe(
    Match.discriminatorsExhaustive("_tag")({
      Classify: (decision) => ({
        type: "choice" as const,
        instructions: decision.instructions,
        criteria: decision.criteria,
      }),
      Rate: (decision) => ({
        type: "score" as const,
        instructions: decision.instructions,
        criteria: decision.criteria,
      }),
      Probability: (decision) => ({
        type: "noul" as const,
        instructions: decision.instructions,
        ...(decision.criteria !== undefined && { criteria: decision.criteria }),
      }),
    }),
  )

type WireBody = {
  readonly model: string
  readonly state: unknown
  readonly questions: Readonly<Record<string, WireQuestion>>
}

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireChoiceAnswer = Schema.Struct({
  type: Schema.Literal("choice"),
  choice: Schema.String,
  confidence: Schema.Number,
  probabilities: Schema.Record(Schema.String, Schema.Number),
})

const WireScoreAnswer = Schema.Struct({
  type: Schema.Literal("score"),
  score: Schema.Number,
  confidence: Schema.Number,
  legend: Schema.Record(Schema.String, Schema.String),
  probabilities: Schema.Record(Schema.String, Schema.Number),
})

const WireNoulAnswer = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Schema.Number,
})

const WireUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
})

const WireResponse = Schema.Struct({
  model: Schema.optional(Schema.String),
  answers: Schema.Record(Schema.String, Schema.Unknown),
  usage: Schema.optional(WireUsage),
})
type WireResponse = typeof WireResponse.Type

const decodeChoice = Schema.decodeUnknownEffect(WireChoiceAnswer)
const decodeScore = Schema.decodeUnknownEffect(WireScoreAnswer)
const decodeNoul = Schema.decodeUnknownEffect(WireNoulAnswer)

const wrongShape = (name: string, cause: unknown): AiError.AiError =>
  new AiError.GenerationFailed({
    provider: "typesafe-ai",
    message: `answer "${name}" did not match the kind its decision asked for`,
    raw: cause,
  })

const missing = (name: string): AiError.AiError =>
  new AiError.GenerationFailed({
    provider: "typesafe-ai",
    message: `no answer for decision "${name}"`,
    raw: undefined,
  })

/**
 * `probabilities` arrives keyed by level index as a string. Read it back
 * positionally against the rubric we sent, so a missing or extra index is a
 * decode failure rather than a hole in the tuple.
 */
const levelsOf = (
  name: string,
  criteria: ReadonlyArray<string>,
  probabilities: Readonly<Record<string, number>>,
): Effect.Effect<ReadonlyArray<number>, AiError.AiError> =>
  Effect.forEach(criteria, (_, index) => {
    const probability = probabilities[String(index)]
    return probability === undefined
      ? Effect.fail(wrongShape(name, `missing level ${index}`))
      : Effect.succeed(probability)
  })

const answerFor = (
  name: string,
  decision: Decision.Decision,
  raw: unknown,
): Effect.Effect<Decision.Answer, AiError.AiError> =>
  Match.value(decision).pipe(
    Match.discriminatorsExhaustive("_tag")({
      Classify: () =>
        decodeChoice(raw).pipe(
          Effect.mapError((cause) => wrongShape(name, cause)),
          Effect.map((wire) => ({ _tag: "Classify" as const, labels: wire.probabilities })),
        ),
      Rate: (rate) =>
        decodeScore(raw).pipe(
          Effect.mapError((cause) => wrongShape(name, cause)),
          Effect.flatMap((wire) =>
            Effect.map(levelsOf(name, rate.criteria, wire.probabilities), (levels) => ({
              _tag: "Rate" as const,
              levels,
              legend: rate.criteria,
            })),
          ),
        ),
      Probability: () =>
        decodeNoul(raw).pipe(
          Effect.mapError((cause) => wrongShape(name, cause)),
          Effect.map((wire) => ({ _tag: "Probability" as const, probability: wire.noul })),
        ),
    }),
  ) as Effect.Effect<Decision.Answer, AiError.AiError>

/**
 * The cast is the generic boundary: a record assembled at runtime cannot
 * prove it inhabits the caller's `JevAnswers<D>`. Each entry is decoded
 * against the kind its own decision asked for, so the shape is checked even
 * though the mapping is not.
 */
const answersOf = <D extends Decision.Decisions>(
  decisions: D,
  wire: WireResponse,
): Effect.Effect<JevAnswers<D>, AiError.AiError> =>
  pipe(
    Record.toEntries(decisions),
    Effect.forEach(([name, decision]) => {
      const raw = wire.answers[name]
      return raw === undefined
        ? Effect.fail(missing(name))
        : Effect.map(answerFor(name, decision, raw), (answer) => [name, answer] as const)
    }),
    Effect.map((entries) => Object.fromEntries(entries) as JevAnswers<D>),
  )

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const transportFailure = (cause: unknown): AiError.AiError =>
  new AiError.Unavailable({ provider: "typesafe-ai", raw: cause })

const httpStatusError = (status: number, body: string): AiError.AiError => {
  const provider = "typesafe-ai"
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

const baseUrl = (config: Config): string => config.baseUrl ?? "https://api.typesafe.ai"

const postSystemOne = (
  config: Config,
  body: WireBody,
): Effect.Effect<WireResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const httpRequest = HttpClientRequest.post(`${baseUrl(config)}/v1/systemone`).pipe(
      HttpClientRequest.bearerToken(config.apiKey),
      HttpClientRequest.bodyJsonUnsafe(body),
    )
    const response = yield* client.execute(httpRequest).pipe(Effect.mapError(transportFailure))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* httpStatusError(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(transportFailure))
    return yield* Schema.decodeUnknownEffect(WireResponse)(json).pipe(
      Effect.mapError(transportFailure),
    )
  })

const decideImpl =
  (config: Config) =>
  <A, D extends Decision.Decisions>(
    definition: Decision.Definition<A, D>,
    request: JevDecideRequest<A>,
  ): Effect.Effect<JevDecideResponse<D>, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      if (Record.isEmptyRecord(definition.decisions)) {
        return yield* Effect.fail(
          new AiError.InvalidRequest({
            provider: "typesafe-ai",
            param: "decisions",
            raw: "a definition must carry at least one decision",
          }),
        )
      }
      // A schema that rejects the input is the caller's bug, not a wire fault.
      const state = yield* Schema.encodeEffect(definition.inputSchema)(request.input).pipe(
        Effect.mapError(
          (cause) =>
            new AiError.InvalidRequest({ provider: "typesafe-ai", param: "input", raw: cause }),
        ),
      )
      const wire = yield* postSystemOne(config, {
        model: request.model,
        state,
        questions: Record.map(definition.decisions, questionToWire),
      })
      const answers = yield* answersOf(definition.decisions, wire)
      return {
        answers,
        usage: {
          ...(wire.usage?.input_tokens !== undefined && { inputTokens: wire.usage.input_tokens }),
          ...(wire.usage?.output_tokens !== undefined && {
            outputTokens: wire.usage.output_tokens,
          }),
        },
      }
    })

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/** Build a `JevService` value. For Layer-based setup, prefer {@link layer}. */
export const make = (config: Config): Effect.Effect<JevService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => ({
    decide: (definition, request) =>
      decideImpl(config)(definition, request).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      ),
  }))

/**
 * Layer registering both the provider-typed `Jev` tag and the generic
 * `DecisionModel` tag over one implementation. `JevAnswers<D>` includes
 * `Answers<D>`, so the generic registration forwards directly.
 */
export const layer = (
  config: Config,
): Layer.Layer<Jev | DecisionModel, never, HttpClient.HttpClient> => {
  const typed = Layer.effect(Jev, make(config))
  const generic = Layer.effect(
    DecisionModel,
    Effect.map(make(config), (service): DecisionModelService => ({
      decide: (definition, request) => service.decide(definition, request),
    })),
  )
  return Layer.merge(typed, generic)
}
