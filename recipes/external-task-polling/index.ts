/**
 * Agent that pauses to wait for an external task (CI pipeline). A polling
 * fiber repeatedly checks pipeline status; the main agent waits on a
 * Deferred that the poller resolves when the pipeline reaches a terminal
 * state.
 *
 * The key primitive is `forkPipelinePoller`: it creates a Deferred, forks
 * the polling fiber, and returns the Deferred for the caller to await.
 *
 * Coordination flow:
 *
 *   1. The model calls `trigger_deploy`. The tool forks a pipeline poller
 *      and captures the Deferred in a side-channel Ref.
 *   2. `onTurnComplete` collects tool results and reads the captured
 *      Deferred into the loop's next state.
 *   3. The next iteration sees `pendingPipeline = Some(deferred)`, awaits
 *      it, injects the pipeline result into history, and resumes the
 *      model turn.
 */
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import * as Loop from "@effect-uai/core/Loop"
import { loop } from "@effect-uai/core/Loop"
import { toFunctionCallOutput, type ToolResult } from "@effect-uai/core/Outcome"
import * as Tool from "@effect-uai/core/Tool"
import { isOutput } from "@effect-uai/core/ToolEvent"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { Deferred, Duration, Effect, Option, Ref, Schedule, Schema, Scope, Stream, pipe } from "effect"

// ---------------------------------------------------------------------------
// Pipeline types
// ---------------------------------------------------------------------------

export type PipelineStatus = "pending" | "running" | "success" | "failure"

export type PipelineResult = {
  readonly pipelineId: string
  readonly status: "success" | "failure"
}

// ---------------------------------------------------------------------------
// Polling effect — repeatedly checks status until a terminal state
// ---------------------------------------------------------------------------

const pollPipeline = (
  pipelineId: string,
  checkStatus: (id: string) => Effect.Effect<PipelineStatus>,
  signal: Deferred.Deferred<PipelineResult>,
  interval: Duration.Input,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const finalStatus = yield* Effect.repeat(checkStatus(pipelineId), {
      until: (s) => s === "success" || s === "failure",
      schedule: Schedule.spaced(interval),
    })
    if (finalStatus === "success" || finalStatus === "failure") {
      yield* Deferred.succeed(signal, { pipelineId, status: finalStatus })
    }
  }).pipe(Effect.annotateLogs({ pipelineId }))

// ---------------------------------------------------------------------------
// Fork helper — creates a Deferred, forks the polling fiber, returns the
// Deferred so the caller can await it.
// ---------------------------------------------------------------------------

export const forkPipelinePoller = (
  pipelineId: string,
  checkStatus: (id: string) => Effect.Effect<PipelineStatus>,
  interval: Duration.Input = "2 seconds",
) =>
  Effect.gen(function* () {
    const signal = yield* Deferred.make<PipelineResult>()
    yield* Effect.forkScoped(pollPipeline(pipelineId, checkStatus, signal, interval))
    return signal
  })

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface State {
  readonly history: ReadonlyArray<Items.Item>
  readonly pendingPipeline: Option.Option<Deferred.Deferred<PipelineResult>>
}

export const initial: State = {
  history: [Items.userText("Deploy the main branch to production and tell me when it completes.")],
  pendingPipeline: Option.none(),
}

// ---------------------------------------------------------------------------
// Conversation — the loop waits on any pending Deferred before each turn
// ---------------------------------------------------------------------------

export const conversation = (
  checkStatus: (id: string) => Effect.Effect<PipelineStatus>,
  pollInterval: Duration.Input = "2 seconds",
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      // The poller must outlive the tool call that forks it. `Stream.unwrap`
      // runs this effect with a Scope that spans the whole conversation
      // stream, so capture it here and fork the poller into it. Forking with
      // the ambient scope (`Effect.forkScoped` inside `forkPipelinePoller`)
      // would instead bind the poller to the ephemeral tool-execution scope,
      // which closes the moment the tool returns — interrupting the poller
      // before it can tick through to a terminal status.
      const conversationScope = yield* Effect.scope

      // Side-channel: the trigger_deploy tool writes the forked Deferred
      // here; the loop body reads it after tool execution completes.
      const pipelineSignal = yield* Ref.make(Option.none<Deferred.Deferred<PipelineResult>>())

      const triggerDeploy = Tool.make({
        name: "trigger_deploy",
        description: "Trigger a CI/CD pipeline deploy. Returns a pipeline ID to track.",
        inputSchema: Tool.fromEffectSchema(Schema.Struct({ branch: Schema.String })),
        run: ({ branch }) =>
          Effect.gen(function* () {
            const pipelineId = `pipeline-${branch}`
            const signal = yield* forkPipelinePoller(pipelineId, checkStatus, pollInterval).pipe(
              Scope.provide(conversationScope),
            )
            yield* Ref.set(pipelineSignal, Option.some(signal))
            return { pipelineId, status: "triggered" }
          }),
        strict: true,
      })

      const tools: ReadonlyArray<Tool.AnyKindTool> = [triggerDeploy]

      return pipe(
        initial,
        loop((state) =>
          Effect.gen(function* () {
            // If a pipeline is pending from the previous turn, block until
            // the polling fiber resolves the Deferred.
            const history = yield* Option.match(state.pendingPipeline, {
              onNone: () => Effect.succeed(state.history),
              onSome: (signal) =>
                Deferred.await(signal).pipe(
                  Effect.tap((r) =>
                    Effect.logInfo("Pipeline resolved").pipe(
                      Effect.annotateLogs({ pipelineId: r.pipelineId, status: r.status }),
                    ),
                  ),
                  Effect.map((r) => [
                    ...state.history,
                    Items.userText(`Pipeline ${r.pipelineId} completed with status: ${r.status}`),
                  ]),
                ),
            })

            const lm = yield* LanguageModel
            return lm
              .streamTurn({ history, model: "gpt-5.4-mini", tools: Tool.toDescriptors(tools) })
              .pipe(
                Loop.onTurnComplete((turn) =>
                  Effect.gen(function* () {
                    const calls = Turn.functionCalls(turn)
                    if (calls.length === 0) return Loop.stop

                    const results = yield* Stream.runFold(
                      Toolkit.executeAll(tools, calls),
                      (): ReadonlyArray<ToolResult> => [],
                      (acc, e) => (isOutput(e) ? [...acc, e.result] : acc),
                    )

                    // Capture any pipeline Deferred the tool may have forked
                    const pendingPipeline = yield* Ref.getAndSet(pipelineSignal, Option.none())

                    return Loop.nextAfter(Stream.empty, {
                      history: [...history, ...turn.items, ...results.map(toFunctionCallOutput)],
                      pendingPipeline,
                    })
                  }),
                ),
              )
          }),
        ),
      )
    }),
  )
