/**
 * Agent that pauses to wait for an external task (CI pipeline). A polling
 * fiber repeatedly checks pipeline status; the main agent waits on a
 * Deferred that the poller resolves when the pipeline reaches a terminal
 * state.
 *
 * The key primitive is `forkPipelinePoller`: it creates a Deferred, forks
 * the polling fiber into an explicit scope, and returns the Deferred for the
 * caller to await.
 *
 * Coordination flow:
 *
 *   1. The model calls `trigger_deploy`. The tool forks a pipeline poller
 *      and offers the Deferred onto a side-channel Queue.
 *   2. At the top of the next iteration the loop drains the Queue
 *      (non-blocking) and awaits every pending Deferred.
 *   3. Each completion (or check failure) is injected into history as a
 *      user message before the model turn runs.
 */
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import * as Loop from "@effect-uai/core/Loop"
import { loop } from "@effect-uai/core/Loop"
import { toToolCallOutput } from "@effect-uai/core/ToolResult"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { Data, Deferred, Duration, Effect, Queue, Schedule, Schema, Scope, Stream, pipe } from "effect"

// ---------------------------------------------------------------------------
// Pipeline types — a single source of truth shared as both a type and a
// runtime validator/guard (`Schema.is`).
// ---------------------------------------------------------------------------

export const PipelineStatus = Schema.Literals(["pending", "running", "success", "failure"])
export type PipelineStatus = typeof PipelineStatus.Type

const TerminalStatus = Schema.Literals(["success", "failure"])
export type TerminalStatus = typeof TerminalStatus.Type

/** Total terminal-state detection with narrowing, defined once. */
const isTerminalStatus = Schema.is(TerminalStatus)

export type PipelineResult = {
  readonly pipelineId: string
  readonly status: TerminalStatus
}

/** A failed status check (e.g. the CI provider returned a non-2xx). */
export class PipelineCheckError extends Data.TaggedError("PipelineCheckError")<{
  readonly pipelineId: string
  readonly cause: unknown
}> {}

export type CheckStatus = (id: string) => Effect.Effect<PipelineStatus, PipelineCheckError>

// ---------------------------------------------------------------------------
// Polling effect — repeatedly checks status until a terminal state, then
// routes the outcome (success OR failure) into the Deferred via
// `Deferred.into`. This is the safety net: whoever awaits the Deferred is
// always released, even when `checkStatus` fails.
// ---------------------------------------------------------------------------

const pollPipeline = (
  pipelineId: string,
  checkStatus: CheckStatus,
  signal: Deferred.Deferred<PipelineResult, PipelineCheckError>,
  interval: Duration.Input,
): Effect.Effect<boolean> =>
  Effect.repeat(checkStatus(pipelineId), {
    until: isTerminalStatus,
    schedule: Schedule.spaced(interval),
  }).pipe(
    Effect.flatMap((status) =>
      isTerminalStatus(status)
        ? Effect.succeed<PipelineResult>({ pipelineId, status })
        : Effect.fail(new PipelineCheckError({ pipelineId, cause: `non-terminal status: ${status}` })),
    ),
    Deferred.into(signal),
    Effect.annotateLogs({ pipelineId }),
  )

// ---------------------------------------------------------------------------
// Fork helper — creates a Deferred, forks the polling fiber into the given
// scope (`Effect.forkIn` takes the scope as an explicit value), and returns
// the Deferred so the caller can await it. The fiber is interrupted when the
// scope closes — no leaked fibers.
// ---------------------------------------------------------------------------

export const forkPipelinePoller = (
  pipelineId: string,
  checkStatus: CheckStatus,
  scope: Scope.Scope,
  interval: Duration.Input = "2 seconds",
) =>
  Effect.gen(function* () {
    const signal = yield* Deferred.make<PipelineResult, PipelineCheckError>()
    yield* Effect.forkIn(pollPipeline(pipelineId, checkStatus, signal, interval), scope)
    return signal
  })

// ---------------------------------------------------------------------------
// State — just the history. Pending pollers live on the side-channel Queue,
// not in loop state.
// ---------------------------------------------------------------------------

export interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
}

export const initial: State = {
  history: [Items.userText("Deploy the main branch to production and tell me when it completes.")],
}

// ---------------------------------------------------------------------------
// Conversation — the loop drains any pending pipelines and awaits them
// before each turn.
// ---------------------------------------------------------------------------

export const conversation = (checkStatus: CheckStatus, pollInterval: Duration.Input = "2 seconds") =>
  Stream.unwrap(
    Effect.gen(function* () {
      // The poller must outlive the tool call that forks it. `Stream.unwrap`
      // runs this effect with a Scope that spans the whole conversation
      // stream; capturing it here and forking into it (rather than the
      // ephemeral tool-execution scope) keeps the poller alive until the
      // conversation ends.
      const conversationScope = yield* Effect.scope

      // Side channel: the trigger_deploy tool offers each forked Deferred
      // here; the loop body drains them at the top of the next turn. A Queue
      // (vs a single-slot Ref) keeps every poller when the model triggers
      // several deploys in one turn — `Toolkit.run` runs tools concurrently.
      const pending = yield* Queue.unbounded<Deferred.Deferred<PipelineResult, PipelineCheckError>>()

      const triggerDeploy = Tool.make({
        name: "trigger_deploy",
        description: "Trigger a CI/CD pipeline deploy. Returns a pipeline ID to track.",
        inputSchema: Tool.fromEffectSchema(Schema.Struct({ branch: Schema.String })),
        run: ({ branch }) =>
          Effect.gen(function* () {
            const pipelineId = `pipeline-${branch}`
            const signal = yield* forkPipelinePoller(pipelineId, checkStatus, conversationScope, pollInterval)
            yield* Queue.offer(pending, signal)
            return { pipelineId, status: "triggered" }
          }),
        strict: true,
      })

      const tools: ReadonlyArray<Tool.AnyTool> = [triggerDeploy]

      return pipe(
        initial,
        loop((state) =>
          Effect.gen(function* () {
            // Drain (non-blocking — empty array when nothing pending) every
            // pipeline forked in previous turns, then block on each before
            // the next turn. `Queue.clear` returns immediately; `takeAll`
            // would block until at least one element is present.
            const signals = yield* Queue.clear(pending)
            const messages = yield* Effect.forEach(
              signals,
              (signal) =>
                Deferred.await(signal).pipe(
                  Effect.tap((r) =>
                    Effect.logInfo("Pipeline resolved").pipe(
                      Effect.annotateLogs({ pipelineId: r.pipelineId, status: r.status }),
                    ),
                  ),
                  Effect.map((r) => Items.userText(`Pipeline ${r.pipelineId} completed with status: ${r.status}`)),
                  Effect.catch((e) =>
                    Effect.succeed(Items.userText(`Pipeline ${e.pipelineId} status check failed (${e._tag})`)),
                  ),
                ),
              { concurrency: "unbounded" },
            )
            const history = [...state.history, ...messages]

            const lm = yield* LanguageModel
            return lm
              .streamTurn({ history, model: "gpt-5.4-mini", tools: Tool.toDescriptors(tools) })
              .pipe(
                Loop.onTurnComplete((turn) =>
                  Effect.sync(() => {
                    const calls = Turn.getToolCalls(turn)
                    if (calls.length === 0) return Loop.stop()

                    // `continueWithResults` streams tool events to the consumer and
                    // folds their outputs into the next state's history.
                    return Toolkit.run(tools, calls).pipe(
                      Toolkit.continueWithResults((results) =>
                        Turn.appendToHistory({ history }, turn, results.map(toToolCallOutput)),
                      ),
                    )
                  }),
                ),
              )
          }),
        ),
      )
    }),
  )
