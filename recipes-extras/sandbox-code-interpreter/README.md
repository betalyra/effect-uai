---
title: Run, fix, repeat
description: Your agent needs an exact answer. Give it Python and a sandbox — and let it correct its own mistakes.
source: recipes-extras/sandbox-code-interpreter
icon: PiTerminalWindow
---

LLMs are bad at exact computation. Arithmetic past a few digits, hashing,
parsing, token counting, parsing a CSV correctly — they fudge or hallucinate.
Worse, you usually only notice once the wrong answer is already in your
user's hands.

Give them Python.

This recipe wires a `run_python` tool to a sandboxed microVM. The model
writes a program; the sandbox runs it; if it crashes, the model sees the
traceback in its next context window and tries again with corrected code.
By the time the model replies to the user, the answer was actually
computed — not guessed.

**One real trace.** "What is the 1000th prime number?" (no human in the
loop)

1. Model writes `import sympy; print(sympy.prime(1000))` →
   `ModuleNotFoundError` (the slim image plus `Network.blocked` means it
   can't `pip install`).
2. It reads the traceback, rewrites in pure stdlib → `7919`.
3. Replies "The 1000th prime number is **7919**."

The whole point of the recipe is that step 2 happens automatically.
The sandbox isn't an executor; it's the **feedback signal** the loop
uses to decide what to do next.

## What it shows

- A standard agentic loop (`Loop.loop` + `onTurnComplete`) where each
  tool call is a sandbox `exec`. Same shape as
  [basic-usage](/recipes/basic-usage/) — the only new thing is what the
  tool does.
- One sandbox created at the top of the program and reused across every
  tool call. Boot cost is paid once; subsequent execs are tens of
  milliseconds.
- `Network.blocked` on create — the model can't `pip install` its way
  out of the problem. It has to write Python that works with the stdlib.
- Scope-bound destruction — when the program ends, the sandbox is gone.

## The loop, in shape

```ts
export const conversation = (service: LanguageModelService, model: string, sb: SandboxInstance) => {
  const toolkit = Toolkit.make([makeRunPython(sb)])
  const tools = Toolkit.toDescriptors(toolkit)

  // After each turn: tool calls → run them and continue; no tool calls → stop.
  const nextStep = (state: State, turn: Turn.Turn) =>
    Arr.match(Turn.functionCalls(turn), {
      onEmpty: () => stop,
      onNonEmpty: (calls) =>
        Toolkit.executeAll(toolkit.tools, calls).pipe(
          Toolkit.continueWith((results) =>
            Turn.appendTurn(
              { ...state, index: state.index + 1 },
              turn,
              results.map(toFunctionCallOutput),
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
```

This is the exact same harness as [basic-usage](/recipes/basic-usage/).
The only difference is what `makeRunPython` does — every iteration the
model either calls the tool (sandbox runs Python, output appended to
history, loop continues) or doesn't (the model produced its final
answer, loop stops).

The "self-correction" isn't anywhere in this code. It falls out for
free: the tool output is in history, the next `streamTurn` sees it, and
the model decides whether it's done or wants to try again.

## The tool, in shape

```ts
const makeRunPython = (sb: SandboxInstance) =>
  Tool.make({
    name: "run_python",
    description:
      "Run a Python program inside a sandboxed microVM. Returns exit code, stdout, and stderr.",
    inputSchema: Tool.fromEffectSchema(Schema.Struct({ code: Schema.String })),
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
```

The closure captures `sb` so every invocation hits the same sandbox.
The returned record is what the model sees on its next turn — the
non-zero `exitCode` and the `stderr` traceback are exactly the feedback
that makes self-correction possible.

## Run it

You'll need the `msb` daemon running (`npx microsandbox install` once,
then `msb server start`) on Linux/KVM or macOS/Apple Silicon, plus an
API key for one of `ANTHROPIC_API_KEY` (default), `OPENAI_API_KEY`, or
`GOOGLE_API_KEY`.

```sh
# install once
pnpm -C recipes-extras/sandbox-code-interpreter install --ignore-workspace

# run (pass --provider openai|google to switch)
ANTHROPIC_API_KEY=sk-... \
  ./recipes-extras/sandbox-code-interpreter/node_modules/.bin/tsx \
  recipes-extras/sandbox-code-interpreter/run.ts
```

The unusual `--ignore-workspace` flag and the direct `tsx` invocation
are explained in [`recipes-extras/README.md`](https://github.com/betalyra/effect-uai/blob/main/recipes-extras/README.md).
Short version: this recipe lives outside the pnpm workspace so its
heavy native deps stay out of the monorepo's root `node_modules`.

Full source:
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes-extras/sandbox-code-interpreter/index.ts),
[`run.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes-extras/sandbox-code-interpreter/run.ts).
