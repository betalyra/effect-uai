---
title: Agentic loop with input queue
description: A long-lived loop that pulls user messages from a queue, debounces bursts into a single batch, and only checks for new input between cleanly-finished turns.
---

**Scenario.** Your agent runs as a chat — the user types, the model
replies, sometimes calls a tool, sometimes just answers, and then you
go back to waiting for the next message. Two real-world details:

- Users send messages in **bursts** ("hi" → "actually" → "what time
  is it in Lisbon"). Sending three separate turns is wasteful and
  confuses the model. Coalesce them.
- The model is mid-task when it calls a tool. Don't go ask the user
  for input — they're waiting for an answer.

This recipe wires both behaviors into one small loop body.

## The shape

```ts
loop((state) =>
  Effect.gen(function* () {
    // Drain the queue ONLY when the previous turn ended cleanly.
    // Tool-output turns flow straight into the next iteration.
    const incoming = needsUserInput(state) ? yield* drainBurst(queue, settle) : []
    const history = [...state.history, ...incoming.map(Items.userText)]

    const lm = yield* LanguageModel
    return lm.streamTurn({ history, model, tools }).pipe(
      streamUntilComplete<State, ToolEvent>((turn) =>
        Effect.sync(() => {
          const calls = Turn.functionCalls(turn)
          if (calls.length === 0) {
            return nextAfter(Stream.empty, { history: [...history, ...turn.items] })
          }
          const events = Toolkit.executeAll(tools, calls)
          return Toolkit.nextStateFrom(events, (results) => ({
            history: [...history, ...turn.items, ...results.map(toFunctionCallOutput)],
          }))
        }),
      ),
    )
  }),
)
```

The whole queue mechanic comes down to one decision at the top of
each iteration: do we need user input *right now*?

```ts
const needsUserInput = (state: State): boolean => {
  const last = state.history[state.history.length - 1]
  if (last === undefined) return true
  return last.type === "message" && last.role === "assistant"
}
```

- Empty history → first iteration, wait for the user.
- Last item is an assistant message → previous turn finished clean,
  wait for the user.
- Last item is a `function_call_output` → mid-task, run the model
  again immediately.

## Debounced burst collection

`drainBurst` is the input side. It blocks for the first message,
then keeps collecting while new messages arrive within `settle` of
each other. The window resets on every arrival, so a burst of typing
flows together and a single message followed by silence ends the
burst right away.

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

Modeled as `Stream.unfold` over a seed that flips after the first
message: subsequent steps race the next take against the settle
window. `runCollect` materializes the burst as an array.

When sleep wins the race the in-flight `Queue.take` is interrupted,
which is safe — `Queue.take` only removes items on successful resume,
so an item that lands at the exact moment of interruption stays in
the queue for the next `drainBurst` call.

## Termination

The loop never decides to stop. The runner forks the conversation
fiber and interrupts it on `Ctrl-C` (or in tests, after the assertions
land). That mirrors how a real chat agent behaves — the lifetime is a
session concern, not a loop concern.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/agentic-loop/run.ts
```

The runner is an interactive CLI: you type, the agent replies. Two
toy tools (`get_current_time`, `flip_coin`) each take a few hundred
milliseconds to simulate real work, so multi-turn responses are
visible. Try sending a quick burst of messages — they'll land in one
user batch — or type a new message while the agent is still working
on the previous one to see it picked up at the next turn boundary.

The runner uses `get_current_time(timezone)` and `roll_dice(sides)`;
both have a `delay` of a few hundred ms so multi-turn flow is
observable on the terminal.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/agentic-loop/index.ts).
