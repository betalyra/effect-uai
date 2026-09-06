/**
 * Runtime-agnostic composition of the native-deep-research recipe.
 *
 * `--provider perplexity|openai|google` is the recipe's subject: all three
 * ship a provider-hosted `DeepResearch` job, and the recipe runs against the
 * generic tag, so swapping providers changes only the Layer. `--model`
 * overrides the per-provider default, `--question` asks something else.
 *
 * The Layer comes from `_shared/model.ts`; `run.ts` supplies the platform
 * `HttpClient` and `FileSystem`. A real run takes minutes: the job runs
 * server-side and the stream reports progress until it completes. The report
 * lands in `output/native-deep-research/<timestamp>/report.md`.
 */
import { Console, Effect, FileSystem, Match, Option, Ref, Stdio, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Turn from "@effect-uai/core/Turn"
import { flagValue, providerChoice } from "@effect-uai/recipe-kit/argv"
import { deepResearchLayer } from "../_shared/model.js"
import { runDir } from "@effect-uai/recipe-kit/output"
import { nativeDeepResearch } from "./recipe.js"

export type Provider = "perplexity" | "openai" | "google"

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const write = (s: string) =>
  Effect.sync(() => {
    process.stdout.write(s)
  })

// ---------------------------------------------------------------------------
// Flags. The model default follows the provider.
// ---------------------------------------------------------------------------

const defaultModel: Record<Provider, string> = {
  perplexity: "sonar-deep-research",
  openai: "o3-deep-research",
  google: "deep-research-preview-04-2026",
}

const readFlags = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const provider = yield* providerChoice("perplexity", "openai", "google")
  return {
    provider,
    model: Option.getOrElse(flagValue("model", argv), () => defaultModel[provider]),
    question: Option.getOrElse(
      flagValue("question", argv),
      () => "What are the most significant AI research developments of the past month?",
    ),
    outDir: yield* runDir("native-deep-research", argv),
  }
})

const urlCitations = (turn: Turn.Turn) => Turn.citations(turn).filter(Items.isUrlCitation)

const toMarkdown = (question: string, turn: Turn.Turn): string => {
  const sources = urlCitations(turn)
  const body = [`# Deep research report`, ``, `> ${question}`, ``, Turn.assistantText(turn)]
  const sourceList =
    sources.length === 0
      ? []
      : [
          "",
          "## Sources",
          "",
          ...sources.map((c, i) => `${i + 1}. [${c.title ?? c.url}](${c.url})`),
        ]
  return [...body, ...sourceList, ""].join("\n")
}

// ---------------------------------------------------------------------------
// Bootstrap effect: resolve the flag, stream the recipe under the chosen
// provider Layer rendering live progress, then print + save the report.
// ---------------------------------------------------------------------------

export const main = Effect.gen(function* () {
  const flags = yield* readFlags
  const fs = yield* FileSystem.FileSystem
  const report = `${flags.outDir}/report.md`

  yield* Effect.logInfo(`native-deep-research (provider: ${flags.provider} ${flags.model})`)
  yield* Effect.logInfo(`question: ${flags.question}`)
  yield* Effect.logInfo(
    "the job runs server-side for minutes; streaming progress until it completes...",
  )
  yield* Console.log("")

  // Search-lifecycle + reasoning render dimmed as they arrive; `TextDelta`
  // (streaming providers) prints the report as it is written. Poll-only
  // providers emit no `TextDelta`, so the report lives only in the terminal
  // `Turn`: captured here, printed afterwards if it was not streamed.
  const streamed = yield* Ref.make(false)
  const finalTurn = yield* Ref.make(Option.none<Turn.Turn>())

  yield* nativeDeepResearch({ question: flags.question, model: flags.model }).pipe(
    Stream.runForEach(
      Match.type<Turn.TurnEvent>().pipe(
        Match.tag("WebSearchCall", (e) =>
          Console.log(dim(`  · ${e.status}${e.query !== undefined ? `: ${e.query}` : ""}`)),
        ),
        Match.tag("ReasoningDelta", (e) => write(dim(e.text))),
        Match.tag("TextDelta", (e) =>
          Effect.gen(function* () {
            yield* Ref.set(streamed, true)
            yield* write(e.text)
          }),
        ),
        Match.tag("TurnComplete", (e) => Ref.set(finalTurn, Option.some(e.turn))),
        Match.orElse(() => Effect.void),
      ),
    ),
    Effect.provide(deepResearchLayer(flags)),
  )

  yield* Option.match(yield* Ref.get(finalTurn), {
    onNone: () => Console.log("\n(no report was produced)"),
    onSome: (turn) =>
      Effect.gen(function* () {
        // Print the report body unless it already streamed token-by-token.
        if (!(yield* Ref.get(streamed))) yield* Console.log(`\n${Turn.assistantText(turn)}`)

        const sources = urlCitations(turn)
        if (sources.length > 0) {
          yield* Console.log("\nSources:")
          yield* Effect.forEach(sources, (c, i) =>
            Console.log(`  [${i + 1}] ${c.title ?? c.url}  ${c.url}`),
          )
        }

        yield* fs.makeDirectory(flags.outDir, { recursive: true })
        yield* fs.writeFileString(report, toMarkdown(flags.question, turn))
        yield* Console.log(`\nReport saved to ${report}`)
      }),
  })
}).pipe(
  // Print the whole typed error, not a shallow `[Object]`. For a provider
  // rejection that includes the `raw` body.
  Effect.tapError((error) =>
    Console.error(`\n[native-deep-research] request failed:\n${JSON.stringify(error, null, 2)}`),
  ),
)
