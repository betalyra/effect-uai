---
title: Agentic loop with input queue
description: A long-lived loop that pulls user messages from a queue, debounces bursts into a single batch, and only checks for new input between cleanly-finished turns.
---

Most demos start with a single prompt. Real chat agents are long-lived: they
wait for users, absorb bursts of typing, run tools, and only ask for new input
when the previous model turn has actually finished.

This recipe keeps that lifecycle explicit. The user input queue is just another
Effect value, and the agent loop decides at the top of each iteration whether
to wait for the user or continue the model/tool exchange already in progress.

**Scenario.** Run an interactive CLI agent. If the user types several messages
quickly, collect them into one batch. If the model calls a tool, execute it and
send the tool output back before checking the queue again.

## The Design Move

The whole recipe turns on one question:

> Does the model need fresh user input, or does it still owe us a response?

That decision is ordinary state inspection:

```ts
const needsUserInput = (state: State): boolean => {
  const last = state.history[state.history.length - 1]
  if (last === undefined) return true
  return last.type === "message" && last.role === "assistant"
}
```

- Empty history means this is the first iteration, so wait for the user.
- An assistant message means the last turn finished cleanly, so wait again.
- A `function_call_output` means the model is mid-task, so run the next turn
  immediately without draining the input queue.

## The Loop

```ts
loop((state) =>
  Effect.gen(function* () {
    // Only wait for the user at clean turn boundaries.
    const incoming = needsUserInput(state) ? yield* drainBurst(queue, settle) : []
    const history = [...state.history, ...incoming.map(Items.userText)]

    const lm = yield* LanguageModel
    return lm.streamTurn({ history, model: "gpt-5.4-mini", tools: descriptors }).pipe(
      onTurnComplete<State, ToolEvent>((turn) =>
        Effect.sync(() => {
          const calls = Turn.functionCalls(turn)

          // No tools means the assistant answered. The next iteration waits.
          if (calls.length === 0) {
            return nextAfter(Stream.empty, Turn.appendTurn({ history }, turn))
          }

          // Tools mean the model needs their outputs before the user speaks again.
          return Toolkit.executeAll(tools, calls).pipe(
            Toolkit.continueWith((results) =>
              Turn.appendTurn({ history }, turn, results.map(toFunctionCallOutput)),
            ),
          )
        }),
      ),
    )
  }),
)
```

The important part is not the queue. The important part is that the chat
lifetime stays in your program. You can swap the CLI queue for WebSocket
messages, a job queue, a database-backed inbox, or a mobile push channel
without changing the model/tool continuation shape.

## Debounced burst collection

`drainBurst` is the input side. It blocks for the first message, then keeps
collecting while new messages arrive within `settle` of each other. The window
resets on every arrival, so a burst of typing becomes one user batch.

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

Modeled as `Stream.unfold`, the first step waits indefinitely and subsequent
steps race the next queue item against the settle window. If sleep wins, the
in-flight `Queue.take` is interrupted safely: an item is removed only when the
take succeeds, so late arrivals remain for the next drain.

## Termination

This conversation never returns `stop` on its own. A real chat session is
usually owned by a server request, WebSocket, tab, worker, or process. The
runner mirrors that shape by forking the conversation fiber and interrupting it
on `Ctrl-C`.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/agentic-loop/run.ts
```

The runner is an interactive CLI. Try sending a quick burst of messages: they
land in one user batch. Then type while the agent is still working: the message
waits in the queue until the current model/tool turn reaches a clean boundary.

The runner includes `get_current_time(timezone)` and `roll_dice(sides)` with a
small artificial delay so the multi-turn flow is visible in the terminal.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/agentic-loop/index.ts).
