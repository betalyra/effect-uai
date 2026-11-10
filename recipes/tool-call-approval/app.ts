/**
 * Composition for the tool-call-approval recipe: the demo answer policy is
 * in `recipe.ts`; this file drives the queue variant and logs each approval
 * request, tool outcome and completed turn.
 */
import { Effect, Match, Option, Queue, Stdio, Stream } from "effect"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { type Answer, DEFAULT_MODEL, demoAnswer, queueConversation } from "./recipe.js"

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", yield* stdio.args), () => DEFAULT_MODEL),
    "openai",
  )
  const answers = yield* Queue.unbounded<Answer>()

  yield* Stream.runForEach(queueConversation(answers, undefined, spec.model), (event) =>
    Match.value(event).pipe(
      Match.discriminators("_tag")({
        ApprovalRequested: (e) =>
          Effect.gen(function* () {
            yield* Effect.logInfo("approval requested", {
              tool: e.call.name,
              call_id: e.call.call_id,
            })
            yield* Effect.sleep("400 millis")
            yield* Queue.offer(answers, demoAnswer(e))
          }),
        Output: ({ call_id, tool, result }) =>
          Effect.logInfo("tool outcome", {
            call_id,
            tool,
            ...(result._tag === "Success" ? { value: result.success } : { error: result.failure }),
          }),
        TurnComplete: ({ turn }) =>
          Effect.logInfo("turn complete", { stop_reason: turn.stop_reason }),
      }),
      Match.orElse(() => Effect.void),
    ),
  ).pipe(Effect.provide(languageModelLayer(spec)))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
