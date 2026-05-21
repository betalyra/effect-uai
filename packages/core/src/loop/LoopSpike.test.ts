import { Deferred, Effect, Fiber, Latch, pipe, Ref, Stream, SubscriptionRef } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as AiError from "../domain/AiError.js"
import { TurnEvent } from "../domain/Turn.js"
import {
  type Event,
  loop,
  loopFrom,
  loopWithState,
  next,
  nextAfter,
  onTurnComplete,
  stop,
  stopAfter,
  stopEvent,
  stopWith,
  value,
} from "./LoopSpike.js"

describe("Loop.loop", () => {
  it("threads state across iterations and emits each iteration's substream in order", async () => {
    // Each iter emits [n, n + 0.5] then continues; final iter emits [n] and stops.
    const stream = loop(0, (n: number) =>
      n >= 3
        ? stopAfter(Stream.fromIterable([n]))
        : nextAfter(Stream.fromIterable([n, n + 0.5]), n + 1),
    )

    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(result).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3])
  })

  it("supports iterations that emit zero values and only decide", async () => {
    // Every iteration emits nothing, just bumps state; stops at 5.
    const stream = loop(0, (n: number) =>
      n >= 5 ? Stream.fromIterable([stopEvent]) : Stream.fromIterable([next(n + 1)]),
    )

    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(result).toEqual([])
  })

  it("supports Effect-returning bodies directly (no Stream.unwrap needed)", async () => {
    // Each iter yields an Effect that doubles the state, then emits it.
    // Body returns Effect<Stream> directly; loop unwraps internally.
    const stream = loop(1, (n: number) =>
      Effect.gen(function* () {
        const doubled = yield* Effect.succeed(n * 2)
        return doubled >= 16
          ? stopAfter(Stream.fromIterable([doubled]))
          : nextAfter(Stream.fromIterable([doubled]), doubled)
      }),
    )

    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(result).toEqual([2, 4, 8, 16])
  })

  it("still accepts Stream.unwrap-wrapped bodies for backward compatibility", async () => {
    const stream = loop(1, (n: number) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const doubled = yield* Effect.succeed(n * 2)
          return doubled >= 4
            ? stopAfter(Stream.fromIterable([doubled]))
            : nextAfter(Stream.fromIterable([doubled]), doubled)
        }),
      ),
    )

    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(result).toEqual([2, 4])
  })

  it("propagates errors from the body's stream", async () => {
    const boom = new Error("boom")
    const stream = loop(
      0,
      (n: number): Stream.Stream<Event<number, number>, Error> =>
        n === 2 ? Stream.fail(boom) : Stream.fromIterable([value(n), next(n + 1)]),
    )

    const result = await Effect.runPromiseExit(Stream.runCollect(stream))
    expect(result._tag).toBe("Failure")
  })

  it("terminates silently if the body emits no Decision (mirrors paginate's silent stop)", async () => {
    // No decision emitted - loop just ends after the body's stream completes.
    const stream = loop(0, (n: number) => Stream.fromIterable([value(n), value(n + 1)]))

    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(result).toEqual([0, 1])
  })

  it("short-circuits the body's stream when a Decision is seen", async () => {
    // Body emits [n, next(n+1), n+10]. Once the Decision is encountered, the
    // body's stream is interrupted - `n+10` is never pulled, so it never
    // flows to the outer stream. This is the correct behavior: a Decision
    // marks "I'm done with this iteration"; anything after it is dead code.
    const stream = loop(0, (n: number) =>
      n >= 2
        ? Stream.fromIterable([value(n), stopEvent])
        : Stream.fromIterable([value(n), next(n + 1), value(n + 10)]),
    )

    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(result).toEqual([0, 1, 2])
  })

  it("type: data-last (pipe) form preserves the body's E channel", () => {
    // Regression for the prior inference bug: when used as
    // `pipe(initial, loop(body))`, the body's E must propagate to the outer
    // stream instead of collapsing to `never`. Generics live on the outer
    // return of each overload, so neither calling form can erase them.
    const result = pipe(
      { count: 0 },
      loop((_state) => Stream.fail(new AiError.RateLimited({ provider: "test", raw: null }))),
    )
    type E = typeof result extends Stream.Stream<unknown, infer X, unknown> ? X : never
    expectTypeOf<E>().toEqualTypeOf<AiError.RateLimited>()
  })

  it("type: data-first form preserves the body's E channel", () => {
    const result = loop({ count: 0 }, (_state) =>
      Stream.fail(new AiError.RateLimited({ provider: "test", raw: null })),
    )
    type E = typeof result extends Stream.Stream<unknown, infer X, unknown> ? X : never
    expectTypeOf<E>().toEqualTypeOf<AiError.RateLimited>()
  })

  it("type: onTurnComplete inside loop infers S and A from the handler without annotation", () => {
    // Regression: when piped through loop, onTurnComplete's handler return
    // type (Stream<Event<A, S>>) is the single source of truth for the loop
    // body's element type. The previous workaround required explicit
    // <S, A> at the call site. Now the loop's outer-return generics pull
    // them through automatically.
    type LoopState = { readonly turns: number }
    type ToolEvent = { readonly _tag: "tool"; readonly name: string }

    const result = pipe(
      { turns: 0 } as LoopState,
      loop((state) =>
        Effect.gen(function* () {
          const deltas: Stream.Stream<TurnEvent> = Stream.empty
          return deltas.pipe(
            onTurnComplete(() =>
              Effect.sync(() =>
                state.turns >= 1
                  ? stop
                  : nextAfter(Stream.succeed<ToolEvent>({ _tag: "tool", name: "x" }), {
                      turns: state.turns + 1,
                    }),
              ),
            ),
          )
        }),
      ),
    )

    type Element = typeof result extends Stream.Stream<infer X, unknown, unknown> ? X : never
    expectTypeOf<Element>().toEqualTypeOf<TurnEvent | ToolEvent>()
  })

  it("onTurnComplete: data-first form (Function.dual) works at runtime", async () => {
    // Pin both calling forms: deltas.pipe(onTurnComplete(handler)) and
    // onTurnComplete(deltas, handler). Same dispatch as loop's dual.
    const turnComplete: TurnEvent = TurnEvent.TurnComplete({
      turn: { items: [], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "stop" },
    })
    const textDelta: TurnEvent = TurnEvent.TextDelta({ text: "hi" })
    const deltas: Stream.Stream<TurnEvent> = Stream.fromIterable([textDelta, turnComplete])

    const dataFirst = onTurnComplete(deltas, () => Effect.sync(() => stop))
    const dataLast = deltas.pipe(onTurnComplete(() => Effect.sync(() => stop)))

    const a = await Effect.runPromise(Stream.runCollect(dataFirst))
    const b = await Effect.runPromise(Stream.runCollect(dataLast))

    // Two value(delta) wraps + one stop sentinel from the handler.
    expect(a.length).toBe(3)
    expect(b.length).toBe(3)
  })

  it("is stack-safe and linear-time across many iterations", async () => {
    // 100k iterations far exceeds V8's typical stack depth (~10–15k frames).
    const N = 100_000
    const stream = loop(0, (n: number) =>
      n >= N
        ? Stream.fromIterable([value(n), stopEvent])
        : Stream.fromIterable([value(n), next(n + 1)]),
    )

    const count = await Effect.runPromise(
      Stream.runFold(
        stream,
        (): number => 0,
        (acc) => acc + 1,
      ),
    )
    expect(count).toBe(N + 1) // 0..N inclusive
  }, 10_000)
})

// ---------------------------------------------------------------------------
// Mock LLM scenario - proves the loop forwards deltas in real time and
// correctly threads tool-result events between turns.
// ---------------------------------------------------------------------------

type Delta =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_call"; readonly id: string; readonly name: string }

type HistoryItem =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "tool_call"; readonly id: string; readonly name: string }
  | { readonly type: "tool_result"; readonly id: string; readonly output: string }

type UiEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_started"; readonly id: string; readonly name: string }
  | { readonly type: "tool_result"; readonly id: string; readonly output: string }

interface MockModel {
  readonly streamTurn: (history: ReadonlyArray<HistoryItem>) => Stream.Stream<Delta>
}

interface State {
  readonly history: ReadonlyArray<HistoryItem>
  readonly model: MockModel
}

interface ToolOutcome {
  readonly output: string
  readonly nextModel?: MockModel
}

type ToolRunner = (call: { id: string; name: string }) => ToolOutcome

const scriptedModel = (script: ReadonlyArray<ReadonlyArray<Delta>>): MockModel => {
  let i = 0
  return {
    streamTurn: () => {
      const turn = script[i] ?? []
      i += 1
      return Stream.fromIterable(turn)
    },
  }
}

/**
 * Body factored out so both tests share it. Per iteration:
 *   1. Stream the model's deltas; tap captures texts + tool calls into Refs.
 *   2. flatMap projects deltas into UiEvents forwarded to the outer stream.
 *   3. Continuation reads the captured calls; if any, runs them, emits
 *      tool_result events, builds the next state (with model swap if a tool
 *      asked for one), and emits `next(state)`. Otherwise `stop`.
 */
const conversationLoop = (initial: State, runTool: ToolRunner) =>
  loop(initial, (state) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const textsRef = yield* Ref.make<ReadonlyArray<string>>([])
        const toolCallsRef = yield* Ref.make<
          ReadonlyArray<{ readonly id: string; readonly name: string }>
        >([])

        const deltas: Stream.Stream<Event<UiEvent, State>> = state.model
          .streamTurn(state.history)
          .pipe(
            Stream.tap((d) =>
              d.type === "text"
                ? Ref.update(textsRef, (t) => [...t, d.text])
                : Ref.update(toolCallsRef, (t) => [...t, { id: d.id, name: d.name }]),
            ),
            Stream.flatMap(
              (d): Stream.Stream<Event<UiEvent, State>> =>
                d.type === "text"
                  ? Stream.fromIterable([value<UiEvent>({ type: "text", text: d.text })])
                  : Stream.fromIterable([
                      value<UiEvent>({ type: "tool_started", id: d.id, name: d.name }),
                    ]),
            ),
          )

        const continuation: Stream.Stream<Event<UiEvent, State>> = Stream.unwrap(
          Effect.gen(function* () {
            const texts = yield* Ref.get(textsRef)
            const toolCalls = yield* Ref.get(toolCallsRef)

            if (toolCalls.length === 0) {
              return stopAfter(Stream.empty)
            }

            const turnItems: ReadonlyArray<HistoryItem> = [
              ...(texts.length > 0 ? [{ type: "assistant" as const, text: texts.join("") }] : []),
              ...toolCalls.map(
                (tc): HistoryItem => ({ type: "tool_call", id: tc.id, name: tc.name }),
              ),
            ]

            const outcomes = toolCalls.map((call) => ({ call, outcome: runTool(call) }))

            const events: ReadonlyArray<UiEvent> = outcomes.map(({ call, outcome }) => ({
              type: "tool_result",
              id: call.id,
              output: outcome.output,
            }))

            const resultItems: ReadonlyArray<HistoryItem> = outcomes.map(
              ({ call, outcome }): HistoryItem => ({
                type: "tool_result",
                id: call.id,
                output: outcome.output,
              }),
            )

            // Last requested model wins; default to the current one.
            const nextModel = outcomes.reduce(
              (m, { outcome }) => outcome.nextModel ?? m,
              state.model,
            )

            const nextState: State = {
              history: [...state.history, ...turnItems, ...resultItems],
              model: nextModel,
            }

            return nextAfter(Stream.fromIterable(events), nextState)
          }),
        )

        return Stream.concat(deltas, continuation)
      }),
    ),
  )

describe("Loop.loop - LLM-style scenarios", () => {
  it("forwards text deltas, tool start, tool result, and post-tool text in order", async () => {
    const m = scriptedModel([
      [
        { type: "text", text: "hello" },
        { type: "text", text: " " },
        { type: "text", text: "world" },
        { type: "tool_call", id: "c1", name: "get_time" },
      ],
      [
        { type: "text", text: " time is " },
        { type: "text", text: "12:00" },
      ],
    ])

    const runTool: ToolRunner = (call) => ({
      output: call.name === "get_time" ? "12:00" : "?",
    })

    const initial: State = {
      history: [{ type: "user", text: "what time is it?" }],
      model: m,
    }

    const events = await Effect.runPromise(Stream.runCollect(conversationLoop(initial, runTool)))

    expect(events).toEqual([
      { type: "text", text: "hello" },
      { type: "text", text: " " },
      { type: "text", text: "world" },
      { type: "tool_started", id: "c1", name: "get_time" },
      { type: "tool_result", id: "c1", output: "12:00" },
      { type: "text", text: " time is " },
      { type: "text", text: "12:00" },
    ])
  })

  it("model swap mid-stream: m1 calls upgrade, m2 finishes the response", async () => {
    const m2 = scriptedModel([
      [
        { type: "text", text: "I am m2." },
        { type: "text", text: " The answer is 42." },
      ],
    ])

    const m1 = scriptedModel([
      [
        { type: "text", text: "Hard question." },
        { type: "text", text: " Upgrading." },
        { type: "tool_call", id: "u1", name: "upgrade" },
      ],
    ])

    const runTool: ToolRunner = (call) =>
      call.name === "upgrade" ? { output: "ok", nextModel: m2 } : { output: "?" }

    const initial: State = {
      history: [{ type: "user", text: "what is the meaning of life?" }],
      model: m1,
    }

    const events = await Effect.runPromise(Stream.runCollect(conversationLoop(initial, runTool)))

    expect(events).toEqual([
      { type: "text", text: "Hard question." },
      { type: "text", text: " Upgrading." },
      { type: "tool_started", id: "u1", name: "upgrade" },
      { type: "tool_result", id: "u1", output: "ok" },
      { type: "text", text: "I am m2." },
      { type: "text", text: " The answer is 42." },
    ])
  })
})

describe("Loop.loop - pull-specific stream semantics", () => {
  it("does not start the next iteration when downstream only takes the first value", async () => {
    const bodyCalls = await Effect.runPromise(
      Effect.gen(function* () {
        const callsRef = yield* Ref.make(0)
        const stream = loop(0, (n: number) =>
          Stream.unwrap(
            Ref.update(callsRef, (calls) => calls + 1).pipe(
              Effect.as(
                n >= 10
                  ? Stream.fromIterable([value(n), stopEvent])
                  : Stream.fromIterable([value(n), next(n + 1)]),
              ),
            ),
          ),
        )

        yield* stream.pipe(Stream.take(1), Stream.runCollect)
        return yield* Ref.get(callsRef)
      }),
    )

    expect(bodyCalls).toBe(1)
  })

  it("propagates defects from the body instead of leaving the consumer waiting", async () => {
    const defect = new Error("defect")
    const stream = loop(0, () => Stream.die(defect))

    const result = await Effect.runPromiseExit(Stream.runCollect(stream))

    expect(result._tag).toBe("Failure")
  })

  it("runs body finalizers when a Decision short-circuits the body", async () => {
    const releases = await Effect.runPromise(
      Effect.gen(function* () {
        const releasesRef = yield* Ref.make<ReadonlyArray<number>>([])
        const stream = loop(0, (n: number) =>
          (n >= 1
            ? Stream.fromIterable([value(n), stopEvent])
            : Stream.fromIterable([value(n), next(n + 1), value(n + 10)])
          ).pipe(Stream.ensuring(Ref.update(releasesRef, (values) => [...values, n]))),
        )

        const values = yield* Stream.runCollect(stream)
        expect(values).toEqual([0, 1])
        return yield* Ref.get(releasesRef)
      }),
    )

    expect(releases).toEqual([0, 1])
  })

  it("runs the active body finalizer when the downstream consumer is interrupted", async () => {
    const releases = await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const releasesRef = yield* Ref.make(0)
        const body = (): Stream.Stream<Event<number, never>> =>
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.as(value(0)))),
            Stream.never,
          ).pipe(Stream.ensuring(Ref.update(releasesRef, (n) => n + 1)))
        const stream = loop(0, body)

        const fiber = yield* Effect.forkChild(Stream.runCollect(stream))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)

        return yield* Ref.get(releasesRef)
      }),
    )

    expect(releases).toBe(1)
  })

  it("does not create a body scope if constructing the body stream defects", async () => {
    const defect = new Error("body construction failed")
    const result = await Effect.runPromiseExit(
      Stream.runCollect(
        loop(0, (): Stream.Stream<Event<number, never>> => {
          throw defect
        }),
      ),
    )

    expect(result._tag).toBe("Failure")
  })
})

describe("Loop.loopWithState", () => {
  it("exposes the final state in the SubscriptionRef after the stream completes", async () => {
    const program = Effect.gen(function* () {
      const { stream, state } = yield* loopWithState(0, (n: number) =>
        n >= 3 ? stopAfter(Stream.fromIterable([n])) : nextAfter(Stream.fromIterable([n]), n + 1),
      )
      const values = yield* Stream.runCollect(stream)
      const finalState = yield* SubscriptionRef.get(state)
      return { values: Array.from(values), finalState }
    })

    const { values, finalState } = await Effect.runPromise(program)
    expect(values).toEqual([0, 1, 2, 3])
    // Last `next(state)` was `next(3)` before the iteration that emitted Stop.
    expect(finalState).toBe(3)
  })

  it("the state ref starts at `initial` and stays there if the loop stops without advancing", async () => {
    const program = Effect.gen(function* () {
      const { stream, state } = yield* loopWithState({ count: 7 }, () =>
        Stream.fromIterable([stopEvent]),
      )
      yield* Stream.runDrain(stream)
      return yield* SubscriptionRef.get(state)
    })

    expect(await Effect.runPromise(program)).toEqual({ count: 7 })
  })

  it("a downstream consumer can read the live state between emitted values", async () => {
    // Body emits one value per iteration, then advances. A `Stream.runForEach`
    // consumer reads the ref each time a value arrives — proving the ref
    // tracks loop state without the body needing to surface it.
    const program = Effect.gen(function* () {
      const { stream, state } = yield* loopWithState(0, (n: number) =>
        n >= 3 ? stopAfter(Stream.fromIterable([n])) : nextAfter(Stream.fromIterable([n]), n + 1),
      )
      const seen: Array<{ value: number; stateAfter: number }> = []
      yield* Stream.runForEach(stream, (v) =>
        Effect.gen(function* () {
          seen.push({ value: v, stateAfter: yield* SubscriptionRef.get(state) })
        }),
      )
      return seen
    })

    // For each iter `n`, the consumer reads the ref between values: it sees
    // the iteration's input state. The terminal iter (n=3) stops without
    // advancing, so its read still shows 3.
    expect(await Effect.runPromise(program)).toEqual([
      { value: 0, stateAfter: 0 },
      { value: 1, stateAfter: 1 },
      { value: 2, stateAfter: 2 },
      { value: 3, stateAfter: 3 },
    ])
  })

  it("SubscriptionRef.changes emits every state transition to a concurrent observer", async () => {
    const program = Effect.gen(function* () {
      const start = yield* Latch.make(false)

      // Body waits on the latch in iter 0 so the observer can subscribe first.
      const { stream, state } = yield* loopWithState(0, (n: number) =>
        Effect.gen(function* () {
          if (n === 0) yield* Latch.await(start)
          return n >= 3 ? stopAfter(Stream.empty) : nextAfter(Stream.empty, n + 1)
        }),
      )

      // Fork the observer; take 4 distinct states (initial + 3 transitions).
      const observerFiber = yield* Effect.forkChild(
        SubscriptionRef.changes(state).pipe(Stream.take(4), Stream.runCollect),
      )

      // Give the observer fiber a chance to actually subscribe before the
      // loop starts advancing the ref. Without this, the loop could finish
      // before the observer's pubsub subscription is in place.
      yield* Effect.sleep("10 millis")

      yield* Latch.open(start)
      yield* Stream.runDrain(stream)

      return Array.from(yield* Fiber.join(observerFiber))
    })

    // initial 0, then next(1), next(2), next(3) — four distinct states.
    expect(await Effect.runPromise(program)).toEqual([0, 1, 2, 3])
  })

  it("does not interfere with the body's value stream", async () => {
    const program = Effect.gen(function* () {
      const { stream } = yield* loopWithState(0, (n: number) =>
        n >= 3
          ? stopAfter(Stream.fromIterable([n]))
          : nextAfter(Stream.fromIterable([n, n + 0.5]), n + 1),
      )
      return Array.from(yield* Stream.runCollect(stream))
    })

    expect(await Effect.runPromise(program)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3])
  })
})

describe("Loop.loopFrom", () => {
  it("runs a multi-turn inner loop per input until the body emits stop", async () => {
    // Per input: emit (input + turnsSoFar) twice, then stop. State counts
    // total turns ACROSS inputs. Demonstrates that `next(s)` continues with
    // the SAME input, multiple times per input — not one body call per item.
    const result = await Effect.runPromise(
      Stream.fromIterable(["a", "b"]).pipe(
        loopFrom(0, (turns: number, input: string) => {
          if (turns >= 2 * (input === "a" ? 1 : 2)) return Stream.fromIterable([stopEvent])
          return Stream.fromIterable([value(`${input}:${turns}`), next(turns + 1)])
        }),
        Stream.runCollect,
      ),
    )

    // input="a": turns 0,1 → emit "a:0","a:1"; turns=2 → stop. State threads.
    // input="b": turns 2,3 → emit "b:2","b:3"; turns=4 → stop.
    expect(result).toEqual(["a:0", "a:1", "b:2", "b:3"])
  })

  it("threads state across inputs (audio-pipeline shape)", async () => {
    // History accumulates across inputs. Each input emits its joined view of
    // history+input, then `stopWith` ends the inner loop AND carries the
    // updated history to the next input.
    const result = await Effect.runPromise(
      Stream.fromIterable(["x", "y", "z"]).pipe(
        loopFrom([] as ReadonlyArray<string>, (history: ReadonlyArray<string>, input: string) =>
          Stream.fromIterable([
            value([...history, input].join(",")),
            stopWith([...history, input]),
          ]),
        ),
        Stream.runCollect,
      ),
    )

    expect(result).toEqual(["x", "x,y", "x,y,z"])
  })

  it("simulates a stream of documents with multi-turn tool calls per document", async () => {
    // Document arrives → model "thinks" (one text turn) → calls a tool
    // (one tool turn) → emits final text (one text turn) → done.
    // Three turns per document, two documents.
    type Turn =
      | { readonly kind: "text"; readonly doc: string; readonly text: string }
      | { readonly kind: "tool"; readonly doc: string; readonly tool: string }
    type State = { readonly turn: number; readonly totalTurns: number }

    const result = await Effect.runPromise(
      Stream.fromIterable(["doc1", "doc2"]).pipe(
        loopFrom({ turn: 0, totalTurns: 0 } as State, (state, doc: string) => {
          // Each document runs three turns then stops.
          if (state.turn === 0) {
            return Stream.fromIterable([
              value<Turn>({ kind: "text", doc, text: "thinking" }),
              next({ turn: 1, totalTurns: state.totalTurns + 1 }),
            ])
          }
          if (state.turn === 1) {
            return Stream.fromIterable([
              value<Turn>({ kind: "tool", doc, tool: "search" }),
              next({ turn: 2, totalTurns: state.totalTurns + 1 }),
            ])
          }
          // Final turn — `stopWith` emits the final value, advances state
          // (reset turn to 0 for the next document, bump totalTurns), and
          // ends this document's inner loop in one shot.
          return Stream.fromIterable([
            value<Turn>({ kind: "text", doc, text: "final" }),
            stopWith({ turn: 0, totalTurns: state.totalTurns + 1 }),
          ])
        }),
        Stream.runCollect,
      ),
    )

    expect(result).toEqual([
      { kind: "text", doc: "doc1", text: "thinking" },
      { kind: "tool", doc: "doc1", tool: "search" },
      { kind: "text", doc: "doc1", text: "final" },
      { kind: "text", doc: "doc2", text: "thinking" },
      { kind: "tool", doc: "doc2", tool: "search" },
      { kind: "text", doc: "doc2", text: "final" },
    ])
  })

  it("ends cleanly when the input stream ends mid-conversation", async () => {
    // Single-input case: body advances via `next` then stops cleanly.
    const result = await Effect.runPromise(
      Stream.fromIterable(["only"]).pipe(
        loopFrom(0, (turns: number, input: string) =>
          turns >= 2
            ? Stream.fromIterable([stopEvent])
            : Stream.fromIterable([value(`${input}:${turns}`), next(turns + 1)]),
        ),
        Stream.runCollect,
      ),
    )

    expect(result).toEqual(["only:0", "only:1"])
  })

  it("body's `stop` advances to the next input (does NOT halt the whole stream)", async () => {
    // Three inputs, body always stops on its first emission. All three
    // are processed — `stop` is per-input, not global. To halt the whole
    // stream, end the INPUT stream upstream.
    const result = await Effect.runPromise(
      Stream.fromIterable([1, 2, 3]).pipe(
        loopFrom(0, (_state: number, input: number) =>
          Stream.fromIterable([value(input * 10), stopEvent]),
        ),
        Stream.runCollect,
      ),
    )

    expect(result).toEqual([10, 20, 30])
  })

  it("data-first form (Function.dual) runs identically to data-last", async () => {
    const inputs = Stream.fromIterable([1, 2])
    const result = await Effect.runPromise(
      Stream.runCollect(
        loopFrom(inputs, 0, (state: number, input: number) =>
          state >= input
            ? Stream.fromIterable([stopEvent])
            : Stream.fromIterable([value(state + input), next(state + 1)]),
        ),
      ),
    )

    // input=1: state=0 → emit 1, state→1; state=1≥1 → stop.
    // input=2: state=1 → emit 3, state→2; state=2≥2 → stop.
    expect(result).toEqual([1, 3])
  })

  it("supports Effect-returning bodies (parity with loop)", async () => {
    const result = await Effect.runPromise(
      Stream.fromIterable(["a"]).pipe(
        loopFrom(0, (turns: number, input: string) =>
          Effect.gen(function* () {
            const cur = yield* Effect.succeed(turns)
            if (cur >= 2) return Stream.fromIterable([stopEvent])
            return Stream.fromIterable([value(`${input}:${cur}`), next(cur + 1)])
          }),
        ),
        Stream.runCollect,
      ),
    )

    expect(result).toEqual(["a:0", "a:1"])
  })

  it("type: data-last (pipe) form preserves the body's E channel", () => {
    const result = pipe(
      Stream.fromIterable([1]),
      loopFrom(0, (_state: number, _input: number) =>
        Stream.fail(new AiError.RateLimited({ provider: "test", raw: null })),
      ),
    )
    type E = typeof result extends Stream.Stream<unknown, infer X, unknown> ? X : never
    expectTypeOf<E>().toEqualTypeOf<AiError.RateLimited>()
  })

  it("type: data-first form preserves the body's E channel and unifies with input's E", () => {
    const input: Stream.Stream<number, Error> = Stream.fail(new Error("boom"))
    const result = loopFrom(input, 0, (_state: number, _i: number) =>
      Stream.fail(new AiError.RateLimited({ provider: "test", raw: null })),
    )
    type E = typeof result extends Stream.Stream<unknown, infer X, unknown> ? X : never
    expectTypeOf<E>().toEqualTypeOf<AiError.RateLimited | Error>()
  })
})
