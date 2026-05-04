---
name: effect-uai-agentic-loop
description: Use when the user wants a long-lived chat agent that pulls user messages from a queue, debounces typing bursts into one batch, and only checks for new input between cleanly-finished turns. Mid-task tool exchanges run uninterrupted; new messages are buffered until the next clean turn boundary.
license: MIT
---

# effect-uai agentic-loop

Long-lived chat agent. Drains a user-message queue between cleanly-
finished turns; bursts of typing get coalesced into one batch via a
debounce window; tool-call turns run straight through to the next
iteration without checking for new user input.

Reach for this when the user says any of:

- "Long-lived chat agent with a queue / WebSocket"
- "Coalesce burst messages into one user turn"
- "Interactive CLI agent that keeps running"

## The design move

The whole loop turns on one question at the top of each iteration:

> Does the model need fresh user input, or does it still owe us a response?

That decision is ordinary state inspection:

```ts
const needsUserInput = (state: State): boolean => {
  const last = state.history[state.history.length - 1]
  if (last === undefined) return true                      // first iteration
  return last.type === "message" && last.role === "assistant" // turn finished cleanly
}
```

- Empty history → wait for the user.
- Last item is an assistant message → previous turn finished, wait again.
- Last item is a `function_call_output` → mid-task, run the model again.

## The loop

```ts
import { Duration, Effect, Queue, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, nextAfter, streamUntilComplete } from "@effect-uai/core/Loop"
import { toFunctionCallOutput } from "@effect-uai/core/Outcome"
import * as Tool from "@effect-uai/core/Tool"
import type { ToolEvent } from "@effect-uai/core/ToolEvent"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"

interface State {
  readonly history: ReadonlyArray<Items.Item>
}

export const conversation = (
  queue: Queue.Queue<string>,
  tools: ReadonlyArray<Tool.AnyKindTool>,
  settle: Duration.Input = "150 millis",
) => {
  const descriptors = Tool.toDescriptors(tools)

  return pipe(
    { history: [] } as State,
    loop((state) =>
      Effect.gen(function* () {
        const incoming = needsUserInput(state) ? yield* drainBurst(queue, settle) : []
        const history = [...state.history, ...incoming.map(Items.userText)]

        const lm = yield* LanguageModel
        return lm
          .streamTurn({ history, model: "gpt-5.4-mini", tools: descriptors })
          .pipe(
            streamUntilComplete<State, ToolEvent>((turn) =>
              Effect.sync(() => {
                const calls = Turn.functionCalls(turn)

                if (calls.length === 0) {
                  return nextAfter(Stream.empty, Turn.appendTurn({ history }, turn))
                }

                const events = Toolkit.executeAll(tools, calls)
                return Toolkit.nextStateFrom(events, (results) =>
                  Turn.appendTurn({ history }, turn, results.map(toFunctionCallOutput)),
                )
              }),
            ),
          )
      }),
    ),
  )
}
```

## Debounced burst collection

`drainBurst` blocks for the first message, then keeps collecting while
new messages arrive within `settle` of each other. The window resets
on every arrival.

```ts
export const drainBurst = <A>(
  queue: Queue.Queue<A>,
  settle: Duration.Input,
): Effect.Effect<ReadonlyArray<A>> =>
  Stream.unfold(false, (started) =>
    started
      ? Effect.race(
          Queue.take(queue).pipe(Effect.map((m) => [m, true] as const)),
          Effect.sleep(settle).pipe(Effect.as(undefined)),
        )
      : Queue.take(queue).pipe(Effect.map((m) => [m, true] as const)),
  ).pipe(Stream.runCollect)
```

Modeled as `Stream.unfold` — first step waits indefinitely; subsequent
steps race the next take against the settle window. When sleep wins,
the in-flight `Queue.take` is interrupted safely (items only leave
the queue on successful resume).

## Termination

The loop never returns `stop` on its own. A real chat session is
owned by an external lifetime — server request, WebSocket, tab,
worker, process. The runner / caller terminates by interrupting the
forked fiber:

```ts
const fiber = yield* Effect.forkChild(Stream.runDrain(conversation(queue, tools)))
// ... later, on Ctrl-C / disconnect / timeout
yield* Fiber.interrupt(fiber)
```

## Driving from stdin (interactive CLI)

```ts
import * as readline from "node:readline"

const readStdinInto = (queue: Queue.Queue<string>) =>
  Effect.callback<never>((resume) => {
    const rl = readline.createInterface({ input: process.stdin, terminal: false })
    rl.on("line", (line) => {
      const trimmed = line.trim()
      if (trimmed.length > 0) Queue.offerUnsafe(queue, trimmed)
    })
    rl.on("close", () => resume(Effect.interrupt))
    return Effect.sync(() => rl.close())
  })
```

Fork that alongside the conversation renderer; both terminate
together when the fiber is interrupted (Ctrl-C / EOF).

## See also

- Recipe source: `recipes/agentic-loop/`
- For mid-stream cancellation (abort the current turn): `effect-uai-mid-stream-abort`
- For pause/resume between turns with a latch: `effect-uai-pause-resume`
- For history-sized memory: `effect-uai-auto-compaction`
