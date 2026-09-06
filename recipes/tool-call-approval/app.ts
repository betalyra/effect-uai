/**
 * Composition for the tool-call-approval recipe: the demo verdict policy is
 * in `recipe.ts`; this file drives the queue variant and logs each approval
 * request, tool result and completed turn.
 */
import { Effect, Match, Option, Queue, Stdio, Stream } from "effect"
import type { Verdict } from "@effect-uai/core/Approval"
import { flagValue } from "@effect-uai/recipe-kit/argv"
import { languageModelLayer, parseModelSpec } from "../_shared/model.js"
import { DEFAULT_MODEL, demoVerdict, queueConversation } from "./recipe.js"

export const main = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const spec = parseModelSpec(
    Option.getOrElse(flagValue("model", yield* stdio.args), () => DEFAULT_MODEL),
    "openai",
  )
  const verdicts = yield* Queue.unbounded<Verdict>()

  yield* Stream.runForEach(queueConversation(verdicts, undefined, spec.model), (event) =>
    Match.value(event).pipe(
      Match.when({ _tag: "ApprovalRequested" }, (e) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("approval requested", {
            tool: e.tool,
            call_id: e.call_id,
          })
          yield* Effect.sleep("400 millis")
          yield* Queue.offer(verdicts, demoVerdict(e))
        }),
      ),
      Match.when({ _tag: "Output" }, ({ result }) =>
        Effect.logInfo("tool result", {
          call_id: result.call_id,
          tool: result.tool,
          ...(result._tag === "Ok"
            ? { value: result.value }
            : { kind: result.kind, reason: result.reason }),
        }),
      ),
      Match.when({ _tag: "Progress" }, () => Effect.void),
      Match.discriminators("_tag")({
        TurnComplete: ({ turn }) =>
          Effect.logInfo("turn complete", { stop_reason: turn.stop_reason }),
      }),
      Match.orElse(() => Effect.void),
    ),
  ).pipe(Effect.provide(languageModelLayer(spec)))
}).pipe(Effect.tapCause((cause) => Effect.logError("[main] failed", { cause })))
