/**
 * Runtime-agnostic composition of the deep-research recipe.
 *
 * Same two-flag provider selection as grounded-answer (`--model`,
 * `--search`), the recipe flags (`--question`, `--sub-questions`,
 * `--concurrency`), and a `main` that renders the recipe's tagged event
 * stream to the terminal: the plan, each sub-agent's searches and answer as
 * they stream, then the synthesized report.
 *
 * Both Layers come from `_shared/model.ts`, so nothing here names a vendor.
 * `run.ts` supplies the platform `HttpClient`.
 */
import { Console, Effect, Layer, Match, Option, Ref, Stdio, Stream } from "effect"
import { flagValue, intFlag } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec, webSearchLayer } from "../_shared/model.js"
import { deepResearch, type DeepResearchEvent } from "./recipe.js"

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const DEFAULT_QUESTION =
  "Compare the leading open-source vector databases for production RAG in 2026."

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  return {
    model: parseModelSpec(
      Option.getOrElse(flagValue("model", argv), () => "gpt-5.4-mini"),
      "openai",
    ),
    search: Option.getOrElse(flagValue("search", argv), () => "perplexity"),
    question: Option.getOrElse(flagValue("question", argv), () => DEFAULT_QUESTION),
    subQuestions: intFlag("sub-questions", argv, 4),
    // One at a time by default: search providers rate-limit hard, and a
    // branch that 429s costs more than the parallelism saves.
    concurrency: intFlag("concurrency", argv, 1),
  }
})

// ---------------------------------------------------------------------------
// Render the tagged event stream to the terminal.
// ---------------------------------------------------------------------------

const write = (s: string) =>
  Effect.sync(() => {
    process.stdout.write(s)
  })

const render =
  (reportStarted: Ref.Ref<boolean>) =>
  (ev: DeepResearchEvent): Effect.Effect<void> =>
    Match.value(ev).pipe(
      Match.tag("Planned", (e) =>
        write(`\nPlan:\n${e.subQuestions.map((q, i) => `  ${i + 1}. ${q}`).join("\n")}\n`),
      ),
      Match.tag("BranchStarted", (e) => write(`\n\n## [${e.index + 1}] ${e.question}\n`)),
      Match.tag("Searching", () => write("  [searching the web…]\n")),
      Match.tag("AnswerDelta", (e) => write(e.text)),
      Match.tag("BranchDone", () => write("\n")),
      Match.tag("ReportDelta", (e) =>
        Ref.getAndSet(reportStarted, true).pipe(
          Effect.flatMap((started) =>
            write(started ? e.text : `\n\n${"=".repeat(60)}\n\n${e.text}`),
          ),
        ),
      ),
      Match.exhaustive,
    )

// ---------------------------------------------------------------------------
// Bootstrap.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const flags = yield* readFlags

  yield* Effect.logInfo(
    `deep-research (llm: ${flags.model.provider} ${flags.model.model}, search: ${flags.search})`,
  )
  yield* Effect.logInfo(`question: ${flags.question}`)

  const reportStarted = yield* Ref.make(false)

  yield* deepResearch({
    question: flags.question,
    model: flags.model.model,
    subQuestions: flags.subQuestions,
    concurrency: flags.concurrency,
  }).pipe(
    Stream.runForEach(render(reportStarted)),
    Effect.provide(Layer.mergeAll(languageModelLayer(flags.model), webSearchLayer(flags.search))),
  )

  yield* Console.log("")
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
