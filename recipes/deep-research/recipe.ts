/**
 * Deep research (fully streaming). Answer a broad question that no single
 * search can cover by decomposing it, investigating each part with its own
 * sub-agent, and synthesizing a cited report. Every step streams: you watch
 * each sub-agent search and write, then the final report assemble live.
 *
 * This is the orchestrator pattern the major deep-research products use (a
 * lead agent plans and spawns parallel sub-agents, then reconciles their
 * findings). Where `grounded-answer` is one reactive agent loop, deep
 * research is a pipeline WE drive:
 *
 *   1. PLAN       a structured turn decomposes the question into a fixed set
 *                 of focused sub-questions.
 *   2. INVESTIGATE each sub-question is a bounded `grounded-answer` sub-agent;
 *                 they run concurrently via `Stream.flatMap`. Each one's
 *                 deltas and searches stream out, tagged with its branch.
 *   3. SYNTHESIZE a final streamed turn writes one report from the findings,
 *                 with inline citations and a consolidated source list.
 *
 * Two design choices keep it lean: the sub-agent is the existing
 * `grounded-answer` recipe (composition, not a re-implemented loop), and the
 * orchestrator runs a single plan -> fan-out -> synthesize pass with no
 * re-planning. The iteration that makes it "deep" lives inside each
 * sub-agent, and because each branch is summarized to a short finding before
 * synthesis the final context stays small.
 *
 * The recipe yields one merged `Stream` of tagged {@link DeepResearchEvent}s.
 * Tagging by branch is what makes concurrency legible: a consumer can lane
 * the events per sub-agent (or, at concurrency 1, read them in order).
 *
 * `recipe.ts` is the runtime-agnostic logic; `app.ts` renders the stream and
 * the runners supply the platform HttpClient.
 */
import { Data, Effect, Match, Option, Ref, Result, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import { streamTurn, turn } from "@effect-uai/core/LanguageModel"
import * as StructuredFormat from "@effect-uai/core/StructuredFormat"
import * as Turn from "@effect-uai/core/Turn"
import { groundedAnswer } from "../grounded-answer/recipe.js"

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type DeepResearchEvent = Data.TaggedEnum<{
  /** The plan: the sub-questions about to be investigated. */
  Planned: { readonly subQuestions: ReadonlyArray<string> }
  /** A sub-agent (branch `index`) has begun. */
  BranchStarted: { readonly index: number; readonly question: string }
  /** A sub-agent issued a web search. */
  Searching: { readonly index: number; readonly question: string }
  /** A token of a sub-agent's answer. */
  AnswerDelta: { readonly index: number; readonly question: string; readonly text: string }
  /** A sub-agent finished. */
  BranchDone: { readonly index: number; readonly question: string }
  /** A token of the final synthesized report. */
  ReportDelta: { readonly text: string }
}>
export const DeepResearchEvent = Data.taggedEnum<DeepResearchEvent>()

// ---------------------------------------------------------------------------
// 1. Plan: question -> focused sub-questions (structured)
// ---------------------------------------------------------------------------

const Plan = Schema.Struct({ subQuestions: Schema.Array(Schema.String) })
const planFormat = StructuredFormat.fromEffectSchema(Plan)

const plan = (question: string, model: string, count: number) =>
  turn({
    model,
    structured: planFormat,
    history: [
      Items.userText(
        [
          `Break the research question below into ${count} focused sub-questions.`,
          "Each must be researchable on its own, cover a distinct facet, and not overlap the others.",
          "Return only the sub-questions.",
          "",
          `Question: ${question}`,
        ].join("\n"),
      ),
    ],
  }).pipe(Effect.flatMap((t) => Turn.decodeStructured(t, planFormat)))

// ---------------------------------------------------------------------------
// 2. Investigate: one bounded grounded-answer sub-agent per sub-question.
// The sub-agent streams; we project its events onto branch-tagged events and
// record its final cited answer (the condensed finding) for synthesis.
// ---------------------------------------------------------------------------

type Finding = {
  readonly index: number
  readonly question: string
  readonly answer: string
}

const branchStream = (
  index: number,
  question: string,
  model: string,
  findings: Ref.Ref<ReadonlyArray<Finding>>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const lastTurn = yield* Ref.make(Option.none<Turn.Turn>())

      const record = (answer: string) =>
        Ref.update(findings, (fs) => [...fs, { index, question, answer }])

      const live = groundedAnswer({ question, model, maxRounds: 2, maxResults: 5 }).pipe(
        Stream.tap((ev) =>
          ev._tag === "TurnComplete" ? Ref.set(lastTurn, Option.some(ev.turn)) : Effect.void,
        ),
        Stream.filterMap(
          (ev): Result.Result<DeepResearchEvent, void> =>
            Match.value(ev).pipe(
              Match.tag("TextDelta", (e) =>
                Result.succeed(DeepResearchEvent.AnswerDelta({ index, question, text: e.text })),
              ),
              Match.tag("ToolCallStart", () =>
                Result.succeed(DeepResearchEvent.Searching({ index, question })),
              ),
              Match.orElse(() => Result.failVoid),
            ),
        ),
      )

      const done = Stream.fromEffect(
        Ref.get(lastTurn).pipe(
          Effect.flatMap((lt) =>
            record(
              Option.match(lt, { onNone: () => "(no answer found)", onSome: Turn.assistantText }),
            ),
          ),
          Effect.as(DeepResearchEvent.BranchDone({ index, question })),
        ),
      )

      return Stream.make(DeepResearchEvent.BranchStarted({ index, question })).pipe(
        Stream.concat(live),
        Stream.concat(done),
      )
    }),
  ).pipe(
    // Isolate a failed branch: emit its BranchDone and record a placeholder
    // finding so one sub-agent's failure doesn't sink the whole report.
    Stream.catchCause(() =>
      Stream.fromEffect(
        Ref.update(findings, (fs) => [
          ...fs,
          { index, question, answer: "(research failed)" },
        ]).pipe(Effect.as(DeepResearchEvent.BranchDone({ index, question }))),
      ),
    ),
  )

// ---------------------------------------------------------------------------
// 3. Synthesize: stream one report from all findings. Prose markdown with
// inline citations and a consolidated source list, the shape every
// deep-research product ships.
// ---------------------------------------------------------------------------

const synthesize = (question: string, findings: ReadonlyArray<Finding>, model: string) =>
  streamTurn({
    model,
    history: [
      Items.userText(
        [
          "Write a research report answering the question below, using ONLY the findings provided.",
          "- Do not introduce facts that are not in the findings.",
          "- Open with a short H1 title.",
          "- Cite every claim inline as a markdown link, e.g. [source](https://example.com).",
          "- End with a '## Sources' section listing every URL you cited.",
          "",
          `Question: ${question}`,
          "",
          "Findings:",
          ...findings.map((f) => `### ${f.question}\n${f.answer}`),
        ].join("\n"),
      ),
    ],
  }).pipe(
    Turn.textDeltas,
    Stream.map((text) => DeepResearchEvent.ReportDelta({ text })),
  )

// ---------------------------------------------------------------------------
// Orchestrate
// ---------------------------------------------------------------------------

export type DeepResearchConfig = {
  readonly question: string
  /** Model id for the generic `LanguageModel` (provider chosen by the Layer). */
  readonly model: string
  /** How many sub-questions to investigate. Default `4`. */
  readonly subQuestions?: number
  /**
   * Concurrent sub-agents. `1` (default) streams them one at a time for a
   * readable terminal; raise it to fan out, and lane the branch-tagged events
   * in a richer consumer.
   */
  readonly concurrency?: number
}

export const deepResearch = (cfg: DeepResearchConfig) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const count = cfg.subQuestions ?? 4
      const { subQuestions } = yield* plan(cfg.question, cfg.model, count)
      // Hard-bound the fan-out: don't trust the model to honor the count.
      const questions = subQuestions.slice(0, count)
      const findings = yield* Ref.make<ReadonlyArray<Finding>>([])

      const planned = Stream.make(DeepResearchEvent.Planned({ subQuestions: questions }))

      const investigate = Stream.fromIterable(
        questions.map((question, index) => ({ question, index })),
      ).pipe(
        Stream.flatMap(
          ({ question, index }) => branchStream(index, question, cfg.model, findings),
          {
            concurrency: cfg.concurrency ?? 1,
          },
        ),
      )

      const report = Stream.unwrap(
        Ref.get(findings).pipe(
          Effect.map((fs) =>
            synthesize(
              cfg.question,
              [...fs].sort((a, b) => a.index - b.index),
              cfg.model,
            ),
          ),
        ),
      )

      return planned.pipe(Stream.concat(investigate), Stream.concat(report))
    }),
  )
