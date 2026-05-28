/**
 * Self-correcting code interpreter. The model receives a computational
 * question, calls the `run_python` tool to execute Python in a sandbox,
 * and feeds the exec result back into its next turn — fixing the code
 * if exit code was non-zero. Stops when the model produces a final text
 * answer (no further tool calls).
 *
 * `index.ts` builds the conversation; `run.ts` wires the provider,
 * the Microsandbox layer, and runs it.
 */
import * as Items from "@effect-uai/core/Items"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import type { SandboxInstance } from "@effect-uai/core/Sandbox"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import { toToolCallOutput } from "@effect-uai/core/ToolResult"
import * as Turn from "@effect-uai/core/Turn"
import { Array as Arr, Effect, Schema, pipe } from "effect"

// ---------------------------------------------------------------------------
// The tool — give the model a Python runtime inside the sandbox
// ---------------------------------------------------------------------------

const RunPythonInput = Schema.Struct({
  code: Schema.String,
})

const makeRunPython = (sb: SandboxInstance) =>
  Tool.make({
    name: "run_python",
    description:
      "Run a Python program inside a sandboxed microVM. Returns exit code, stdout, and stderr. Use this to compute precise answers.",
    inputSchema: Tool.fromEffectSchema(RunPythonInput),
    run: ({ code }) =>
      sb.exec({ cmd: ["python3", "-c", code] }).pipe(
        Effect.map((r) => ({
          exitCode: r.exitCode,
          stdout: r.stdout.trim(),
          stderr: r.stderr.trim(),
          durationMs: r.durationMs,
        })),
      ),
    strict: true,
  })

// ---------------------------------------------------------------------------
// Conversation state + initial question
// ---------------------------------------------------------------------------

const QUESTION = "What is the 1000th prime number?"

const SYSTEM = `You are a careful computational agent. Use the run_python tool to compute precise answers.
If the tool returns a non-zero exit code, read stderr, fix the code, and call the tool again.
When you have a verified answer, reply with just the answer — no code, no commentary.`

interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
  readonly index: number
}

const initial: State = {
  history: [Items.systemText(SYSTEM), Items.userText(QUESTION)],
  index: 0,
}

// ---------------------------------------------------------------------------
// The conversation: model writes code → sandbox runs it → result feeds
// back into the next turn. Loop ends when the model produces a text
// answer with no further tool calls.
// ---------------------------------------------------------------------------

export const conversation = (service: LanguageModelService, model: string, sb: SandboxInstance) => {
  const toolkit = Toolkit.make([makeRunPython(sb)])
  const tools = Toolkit.toDescriptors(toolkit)

  // After each turn: tool calls → run them and continue; no tool calls → stop.
  const nextStep = (state: State, turn: Turn.Turn) =>
    Arr.match(Turn.getToolCalls(turn), {
      onEmpty: () => stop(),
      onNonEmpty: (calls) =>
        Toolkit.run(toolkit.tools, calls).pipe(
          Toolkit.continueWithResults((results) =>
            Turn.appendToHistory(
              { ...state, index: state.index + 1 },
              turn,
              results.map(toToolCallOutput),
            ),
          ),
        ),
    })

  return pipe(
    initial,
    loop((state) =>
      Effect.succeed(
        service
          .streamTurn({ history: state.history, model, tools })
          .pipe(onTurnComplete((turn) => Effect.sync(() => nextStep(state, turn)))),
      ),
    ),
  )
}
