import { Array as A, Context, Effect, Layer, Match, Record, Redacted, Schema, pipe } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import * as AiError from "@effect-uai/core/AiError"
import * as Decision from "@effect-uai/core/Decision"
import {
  type CommonDecideRequest,
  type DecideResponse,
  DecisionModel,
} from "@effect-uai/core/DecisionModel"
import { interactionHttpError, transportFailure } from "./codec.js"
import type { GoogleDecisionModel } from "./models.js"

const PROVIDER = "gemini"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Google reports its own `confidence` on every answer: its estimate that the
 * top answer is right. It is not on the common answer; `Decision.confidence`
 * is ours.
 */
export type GeminiAnswerFor<D> = Decision.AnswerFor<D> & { readonly confidence: number }

export type GeminiAnswers<D extends Decision.Decisions> = {
  readonly [K in keyof D]: GeminiAnswerFor<D[K]>
}

export type GeminiDecideResponse<D extends Decision.Decisions> = Omit<
  DecideResponse<D>,
  "answers"
> & {
  readonly answers: GeminiAnswers<D>
}

export type GeminiDecideRequest<A> = Omit<CommonDecideRequest<A>, "model"> & {
  readonly model: GoogleDecisionModel
}

export type GeminiDecisionModelService = {
  readonly decide: <A, D extends Decision.Decisions>(
    definition: Decision.Definition<A, D>,
    request: GeminiDecideRequest<A>,
  ) => Effect.Effect<GeminiDecideResponse<D>, AiError.AiError>
}

/**
 * Provider-typed tag for Google's Decisions API. Yield this for Google's own
 * `confidence`; yield the generic `DecisionModel` tag for portable code. Both
 * are registered by {@link layer}.
 *
 * @experimental The model class this abstracts is new and the shape may change.
 */
export class GeminiDecisionModel extends Context.Service<
  GeminiDecisionModel,
  GeminiDecisionModelService
>()("@betalyra/effect-uai/providers/google/GeminiDecisionModel") {}

export type Config = {
  readonly apiKey: Redacted.Redacted
  readonly baseUrl?: string
}

// ---------------------------------------------------------------------------
// Codec - request
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
      readonly criteria?: {
        readonly true_description?: string
        readonly false_description?: string
      }
    }

const boundaryToWire = (boundary: Decision.Boundary) => ({
  ...(boundary.true !== undefined && { true_description: boundary.true }),
  ...(boundary.false !== undefined && { false_description: boundary.false }),
})

const questionToWire: (decision: Decision.Decision) => WireQuestion =
  Match.type<Decision.Decision>().pipe(
    Match.discriminatorsExhaustive("_tag")({
      Classify: (d): WireQuestion => ({
        type: "choice",
        instructions: d.instructions,
        criteria: d.criteria,
      }),
      Rate: (d): WireQuestion => ({
        type: "score",
        instructions: d.instructions,
        criteria: d.criteria,
      }),
      Probability: (d): WireQuestion => ({
        type: "noul",
        instructions: d.instructions,
        ...(d.criteria !== undefined && { criteria: boundaryToWire(d.criteria) }),
      }),
    }),
  )

/** A string input goes as written; anything else as its JSON. */
const inputText = (encoded: unknown): string =>
  typeof encoded === "string" ? encoded : JSON.stringify(encoded)

// ---------------------------------------------------------------------------
// Limits, checked before sending
// Reference: https://aistudio.google.com/docs/decisions-api#limits
// ---------------------------------------------------------------------------

const QuestionKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/))
const OptionKey = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
)
const isQuestionKey = Schema.is(QuestionKey)
const isOptionKey = Schema.is(OptionKey)

const MAX_QUESTIONS = 1000
const MAX_OPTIONS = 255

/** Every rule a decision breaks, by name. Empty when it fits. */
const offensesOf = (name: string, decision: Decision.Decision): ReadonlyArray<string> => {
  const key = isQuestionKey(name) ? [] : [`"${name}" is not 1 to 64 of [A-Za-z0-9_-]`]
  const body = Match.value(decision).pipe(
    Match.discriminatorsExhaustive("_tag")({
      Classify: (d): ReadonlyArray<string> => {
        const labels = Record.keys(d.criteria)
        return [
          ...(labels.length < 2 || labels.length > MAX_OPTIONS
            ? [`"${name}" has ${labels.length} labels, not 2 to ${MAX_OPTIONS}`]
            : []),
          ...pipe(
            labels,
            A.filter((label) => !isOptionKey(label)),
            A.map((label) => `"${name}" label "${label}" is not 1 to 128 trimmed characters`),
          ),
        ]
      },
      Rate: (d): ReadonlyArray<string> =>
        d.criteria.length > MAX_OPTIONS
          ? [`"${name}" has ${d.criteria.length} levels, more than ${MAX_OPTIONS}`]
          : [],
      Probability: (): ReadonlyArray<string> => [],
    }),
  )
  return [...key, ...body]
}

const checkLimits = (decisions: Decision.Decisions): Effect.Effect<void, AiError.AiError> => {
  const entries = Record.toEntries(decisions)
  const offenses = [
    ...(entries.length === 0 || entries.length > MAX_QUESTIONS
      ? [`${entries.length} decisions, not 1 to ${MAX_QUESTIONS}`]
      : []),
    ...A.flatMap(entries, ([name, decision]) => offensesOf(name, decision)),
  ]
  return offenses.length === 0
    ? Effect.void
    : Effect.fail(
        new AiError.InvalidRequest({
          provider: PROVIDER,
          param: "decisions",
          raw: offenses.join("; "),
        }),
      )
}

// ---------------------------------------------------------------------------
// Codec - response
// ---------------------------------------------------------------------------

const WireChoice = Schema.Struct({
  type: Schema.Literal("choice"),
  probabilities: Schema.Record(Schema.String, Schema.Finite),
  confidence: Schema.Finite,
})

/** `probabilities` and `legend` are keyed by level index as a string. */
const WireScore = Schema.Struct({
  type: Schema.Literal("score"),
  probabilities: Schema.Record(Schema.String, Schema.Finite),
  confidence: Schema.Finite,
})

const WireNoul = Schema.Struct({
  type: Schema.Literal("noul"),
  noul: Schema.Finite,
  confidence: Schema.Finite,
})

export const WireResponse = Schema.Struct({
  answers: Schema.Record(Schema.String, Schema.Unknown),
  usage: Schema.optionalKey(
    Schema.Struct({
      total_input_tokens: Schema.optionalKey(Schema.Finite),
      total_output_tokens: Schema.optionalKey(Schema.Finite),
    }),
  ),
})
type WireResponse = typeof WireResponse.Type

const decodeResponse = Schema.decodeUnknownEffect(WireResponse)
const decodeChoice = Schema.decodeUnknownEffect(WireChoice)
const decodeScore = Schema.decodeUnknownEffect(WireScore)
const decodeNoul = Schema.decodeUnknownEffect(WireNoul)

const wrongShape = (name: string, raw: unknown): AiError.AiError =>
  new AiError.GenerationFailed({
    provider: PROVIDER,
    message: `answer "${name}" did not match the kind its decision asked for`,
    raw,
  })

type LevelProbabilities = readonly [number, number, ...ReadonlyArray<number>]

/** Read back positionally against the rubric we sent, so a gap fails instead of shifting. */
const levelsOf = (
  name: string,
  criteria: Decision.Levels,
  probabilities: Readonly<Record<string, number>>,
): Effect.Effect<LevelProbabilities, AiError.AiError> =>
  Effect.flatMap(
    Effect.forEach(criteria, (_, index) => {
      const probability = probabilities[String(index)]
      return probability === undefined
        ? Effect.fail(wrongShape(name, `missing level ${index}`))
        : Effect.succeed(probability)
    }),
    ([low, next, ...rest]) =>
      low === undefined || next === undefined
        ? Effect.fail(wrongShape(name, "fewer than two levels"))
        : Effect.succeed<LevelProbabilities>([low, next, ...rest]),
  )

type GeminiAnswer = Decision.Answer & { readonly confidence: number }

const answerFor = (
  name: string,
  decision: Decision.Decision,
  raw: unknown,
): Effect.Effect<GeminiAnswer, AiError.AiError> =>
  Match.value(decision).pipe(
    Match.discriminatorsExhaustive("_tag")({
      Classify: (): Effect.Effect<GeminiAnswer, AiError.AiError> =>
        decodeChoice(raw).pipe(
          Effect.mapError((cause) => wrongShape(name, cause)),
          Effect.map((wire) => ({
            _tag: "Classify",
            labels: wire.probabilities,
            confidence: wire.confidence,
          })),
        ),
      Rate: (rate): Effect.Effect<GeminiAnswer, AiError.AiError> =>
        decodeScore(raw).pipe(
          Effect.mapError((cause) => wrongShape(name, cause)),
          Effect.flatMap((wire) =>
            Effect.map(levelsOf(name, rate.criteria, wire.probabilities), (levels) => ({
              _tag: "Rate" as const,
              levels,
              legend: rate.criteria,
              confidence: wire.confidence,
            })),
          ),
        ),
      Probability: (): Effect.Effect<GeminiAnswer, AiError.AiError> =>
        decodeNoul(raw).pipe(
          Effect.mapError((cause) => wrongShape(name, cause)),
          Effect.map((wire) => ({
            _tag: "Probability",
            probability: wire.noul,
            confidence: wire.confidence,
          })),
        ),
    }),
  )

/**
 * The cast is the generic boundary: a record assembled at runtime cannot
 * prove it inhabits the caller's `GeminiAnswers<D>`. Each entry is decoded
 * against the kind its own decision asked for.
 */
const answersOf = <D extends Decision.Decisions>(
  decisions: D,
  wire: WireResponse,
): Effect.Effect<GeminiAnswers<D>, AiError.AiError> =>
  pipe(
    Record.toEntries(decisions),
    Effect.forEach(([name, decision]) => {
      const raw = wire.answers[name]
      return raw === undefined
        ? Effect.fail(wrongShape(name, "no answer"))
        : Effect.map(answerFor(name, decision, raw), (answer) => [name, answer] as const)
    }),
    Effect.map((entries) => Object.fromEntries<unknown>(entries) as GeminiAnswers<D>),
  )

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const host = (cfg: Config): string =>
  cfg.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta"

const unreadable = (cause: unknown): AiError.AiError =>
  new AiError.GenerationFailed({
    provider: PROVIDER,
    message: "the Decisions API returned a response we could not read",
    raw: cause,
  })

/** A safety block is `ContentFiltered`; limits and malformed questions `InvalidRequest`. */
const post = (
  cfg: Config,
  body: Record<string, unknown>,
): Effect.Effect<WireResponse, AiError.AiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${host(cfg)}/decisions`).pipe(
          HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(cfg.apiKey)),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(Effect.mapError(transportFailure(PROVIDER)))
    if (response.status >= 400) {
      const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* interactionHttpError(PROVIDER)(response.status, text)
    }
    const json = yield* response.json.pipe(Effect.mapError(unreadable))
    return yield* decodeResponse(json).pipe(Effect.mapError(unreadable))
  })

const decide =
  (cfg: Config) =>
  <A, D extends Decision.Decisions>(
    definition: Decision.Definition<A, D>,
    request: GeminiDecideRequest<A>,
  ): Effect.Effect<GeminiDecideResponse<D>, AiError.AiError, HttpClient.HttpClient> =>
    Effect.gen(function* () {
      yield* checkLimits(definition.decisions)
      // A schema that rejects the input is the caller's bug, not a wire fault.
      const encoded = yield* Schema.encodeEffect(definition.inputSchema)(request.input).pipe(
        Effect.mapError(
          (cause) => new AiError.InvalidRequest({ provider: PROVIDER, param: "input", raw: cause }),
        ),
      )
      const wire = yield* post(cfg, {
        model: request.model,
        input: inputText(encoded),
        questions: Record.map(definition.decisions, questionToWire),
      })
      const answers = yield* answersOf(definition.decisions, wire)
      // Output tokens are always 0: only the input is billed.
      return {
        answers,
        usage: {
          ...(wire.usage?.total_input_tokens !== undefined && {
            inputTokens: wire.usage.total_input_tokens,
          }),
          ...(wire.usage?.total_output_tokens !== undefined && {
            outputTokens: wire.usage.total_output_tokens,
          }),
        },
      }
    })

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export const make = (
  cfg: Config,
): Effect.Effect<GeminiDecisionModelService, never, HttpClient.HttpClient> =>
  Effect.map(HttpClient.HttpClient, (client) => ({
    decide: (definition, request) =>
      decide(cfg)(definition, request).pipe(Effect.provideService(HttpClient.HttpClient, client)),
  }))

/**
 * Layer registering the provider-typed tag and the generic `DecisionModel`,
 * both backed by one service. `GeminiAnswers<D>` includes `Answers<D>`, so
 * the generic tag takes the same service.
 */
export const layer = (
  cfg: Config,
): Layer.Layer<GeminiDecisionModel | DecisionModel, never, HttpClient.HttpClient> =>
  Layer.effectContext(
    Effect.map(make(cfg), (service) =>
      Context.make(GeminiDecisionModel, service).pipe(Context.add(DecisionModel, service)),
    ),
  )
