/**
 * Composition for the decision-triage recipe: `--model provider:model`
 * resolved to a Layer by `_shared/model.ts`, `--tickets` swaps in your own
 * scenarios. The triage itself never names a provider.
 */
import { Effect, FileSystem, Option, Schema, Stdio } from "effect"
import * as Decision from "@effect-uai/core/Decision"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { cyan, dim } from "@effect-uai/recipe-kit/render"
import { decisionModelLayer, parseModelSpec } from "../_shared/model.js"
import { sampleTickets, type Ticket, TicketFile, triage, triageTicket } from "./recipe.js"

const readTickets = (file: Option.Option<string>) =>
  Option.match(file, {
    onNone: () => Effect.succeed(sampleTickets),
    onSome: (path) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const text = yield* fs.readFileString(path)
        return yield* Schema.decodeUnknownEffect(TicketFile)(text)
      }),
  })

const renderAnswers = (
  answers: Decision.Answers<(typeof triage)["decisions"]>,
): ReadonlyArray<string> => [
  `  department  ${Decision.ranked(answers.department)
    .map((outcome) => `${outcome.label} ${outcome.probability.toFixed(2)}`)
    .join("   ")}`,
  `  certainty   confidence ${Decision.confidence(answers.department).toFixed(2)}` +
    `   margin ${Decision.margin(answers.department).toFixed(2)}`,
  `  severity    ${answers.severity.legend[Decision.topLevel(answers.severity)]}` +
    `   (expected ${Decision.expectedLevel(answers.severity).toFixed(2)})`,
  `  urgent ${answers.urgent.probability.toFixed(2)}` +
    `   refund ${answers.refund.probability.toFixed(2)}` +
    `   personal data ${answers.personalData.probability.toFixed(2)}`,
]

const triageOne = (model: string, ticket: Ticket) =>
  Effect.gen(function* () {
    const { answers, usage, route, redact } = yield* triageTicket(model, ticket)

    yield* Effect.logInfo(cyan(ticket.subject))
    yield* Effect.forEach(renderAnswers(answers), (line) => Effect.logInfo(dim(line)), {
      discard: true,
    })
    yield* Effect.logInfo(
      `  -> ${route.kind}${redact ? "  [redact before a human sees it]" : ""}`,
      route,
    )
    yield* Effect.logInfo(dim(`  ${usage.inputTokens ?? 0} input tokens, one call`))
  })

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const argv = yield* stdio.args
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", argv), () => "jev-latest"),
    "typesafe",
  )
  const tickets = yield* readTickets(flagValue("tickets", argv))

  yield* Effect.logInfo(`decision-triage (${spec.provider} ${spec.model})`)
  yield* Effect.logInfo(
    dim(`${Object.keys(triage.decisions).length} decisions per ticket, ${tickets.length} tickets`),
  )

  yield* Effect.forEach(tickets, (ticket) => triageOne(spec.model, ticket), {
    discard: true,
  }).pipe(Effect.provide(decisionModelLayer(spec)))
}).pipe(
  Effect.catchTag("ConfigError", (cause) =>
    Effect.logError("[main] set TYPESAFE_AI_API_KEY", { cause }),
  ),
  Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })),
)
