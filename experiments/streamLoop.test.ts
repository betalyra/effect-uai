import { Deferred, Effect, Fiber, Ref, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { type Decision, loop, next, stop } from "./streamLoopChannel.js"
import {
  loop as loopPull,
  next as nextPull,
  stop as stopPull,
} from "./streamLoopPull.js"

interface LoopControls {
  readonly loop: typeof loop
  readonly next: typeof next
  readonly stop: typeof stop
}

const channelControls: LoopControls = { loop, next, stop }
const pullControls: LoopControls = {
  loop: loopPull as typeof loop,
  next: nextPull as unknown as typeof next,
  stop: stopPull as unknown as typeof stop,
}

const implementations: ReadonlyArray<readonly [string, LoopControls]> = [
  ["callbackArray", channelControls],
  ["pull", pullControls],
]

describe.each(implementations)("streamLoop.loop — %s", (_name, controls) => {
  it("threads state across iterations and emits each iteration's substream in order", async () => {
    // Each iter emits [n, n + 0.5] then continues; final iter emits [n] and stops.
    const stream = controls.loop(0, (n: number) =>
      n >= 3
        ? Stream.fromIterable([n, controls.stop])
        : Stream.fromIterable([n, n + 0.5, controls.next(n + 1)]),
    )

    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(result).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3])
  })

  it("supports iterations that emit zero values and only decide", async () => {
    // Every iteration emits nothing, just bumps state; stops at 5.
    const stream = controls.loop(0, (n: number) =>
      n >= 5
        ? Stream.fromIterable([controls.stop])
        : Stream.fromIterable([controls.next(n + 1)]),
    )

    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(result).toEqual([])
  })

  it("supports Effect-driven bodies (state from a yielded Effect)", async () => {
    // Each iter yields an Effect that doubles the state, then emits it.
    const stream = controls.loop(1, (n: number) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const doubled = yield* Effect.succeed(n * 2)
          return doubled >= 16
            ? Stream.fromIterable([doubled, controls.stop])
            : Stream.fromIterable([doubled, controls.next(doubled)])
        }),
      ),
    )

    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(result).toEqual([2, 4, 8, 16])
  })

  it("propagates errors from the body's stream", async () => {
    const boom = new Error("boom")
    const stream = controls.loop(0, (n: number) =>
      n === 2
        ? Stream.fail(boom)
        : Stream.fromIterable([n, controls.next(n + 1)]),
    )

    const result = await Effect.runPromiseExit(Stream.runCollect(stream))
    expect(result._tag).toBe("Failure")
  })

  it("terminates silently if the body emits no Decision (mirrors paginate's silent stop)", async () => {
    // No decision emitted — loop just ends after the body's stream completes.
    const stream = controls.loop(0, (n: number) => Stream.fromIterable([n, n + 1]))

    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(result).toEqual([0, 1])
  })

  it("short-circuits the body's stream when a Decision is seen", async () => {
    // Body emits [n, next(n+1), n+10]. Once the Decision is encountered, the
    // body's stream is interrupted — `n+10` is never pulled, so it never
    // flows to the outer stream. This is the correct behavior: a Decision
    // marks "I'm done with this iteration"; anything after it is dead code.
    const stream = controls.loop(0, (n: number) =>
      n >= 2
        ? Stream.fromIterable([n, controls.stop])
        : Stream.fromIterable([n, controls.next(n + 1), n + 10]),
    )

    const result = await Effect.runPromise(Stream.runCollect(stream))
    expect(result).toEqual([0, 1, 2])
  })

  it("is stack-safe and linear-time across many iterations", async () => {
    // 100k iterations far exceeds V8's typical stack depth (~10–15k frames).
    const N = 100_000
    const stream = controls.loop(0, (n: number) =>
      n >= N
        ? Stream.fromIterable([n, controls.stop])
        : Stream.fromIterable([n, controls.next(n + 1)]),
    )

    const count = await Effect.runPromise(
      Stream.runFold(stream, (): number => 0, (acc) => acc + 1),
    )
    expect(count).toBe(N + 1) // 0..N inclusive
  }, 10_000)
})

// ---------------------------------------------------------------------------
// Mock LLM scenario — proves the loop forwards deltas in real time and
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

type Event =
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
 *   2. flatMap projects deltas into Events forwarded to the outer stream.
 *   3. Continuation reads the captured calls; if any, runs them, emits
 *      tool_result events, builds the next state (with model swap if a tool
 *      asked for one), and emits `next(state)`. Otherwise `stop`.
 */
const conversationLoop = (
  initial: State,
  runTool: ToolRunner,
  controls: LoopControls,
) =>
  controls.loop(initial, (state) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const textsRef = yield* Ref.make<ReadonlyArray<string>>([])
        const toolCallsRef = yield* Ref.make<
          ReadonlyArray<{ readonly id: string; readonly name: string }>
        >([])

        const deltas: Stream.Stream<Event | Decision<State>> = state.model
          .streamTurn(state.history)
          .pipe(
            Stream.tap((d) =>
              d.type === "text"
                ? Ref.update(textsRef, (t) => [...t, d.text])
                : Ref.update(toolCallsRef, (t) => [...t, { id: d.id, name: d.name }]),
            ),
            Stream.flatMap((d): Stream.Stream<Event | Decision<State>> =>
              d.type === "text"
                ? Stream.fromIterable<Event>([{ type: "text", text: d.text }])
                : Stream.fromIterable<Event>([
                    { type: "tool_started", id: d.id, name: d.name },
                  ]),
            ),
          )

        const continuation: Stream.Stream<Event | Decision<State>> = Stream.unwrap(
          Effect.gen(function* () {
            const texts = yield* Ref.get(textsRef)
            const toolCalls = yield* Ref.get(toolCallsRef)

            if (toolCalls.length === 0) {
              return Stream.fromIterable<Event | Decision<State>>([controls.stop])
            }

            const turnItems: ReadonlyArray<HistoryItem> = [
              ...(texts.length > 0
                ? [{ type: "assistant" as const, text: texts.join("") }]
                : []),
              ...toolCalls.map(
                (tc): HistoryItem => ({ type: "tool_call", id: tc.id, name: tc.name }),
              ),
            ]

            const outcomes = toolCalls.map((call) => ({ call, outcome: runTool(call) }))

            const events: ReadonlyArray<Event> = outcomes.map(({ call, outcome }) => ({
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

            return Stream.fromIterable<Event | Decision<State>>([
              ...events,
              controls.next(nextState),
            ])
          }),
        )

        return Stream.concat(deltas, continuation)
      }),
    ),
  )

describe.each(implementations)("streamLoop.loop — LLM-style scenarios — %s", (_name, controls) => {
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

    const events = await Effect.runPromise(
      Stream.runCollect(conversationLoop(initial, runTool, controls)),
    )

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

    const events = await Effect.runPromise(
      Stream.runCollect(conversationLoop(initial, runTool, controls)),
    )

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

describe("streamLoop.loop — pull-specific stream semantics", () => {
  it("does not start the next iteration when downstream only takes the first value", async () => {
    const bodyCalls = await Effect.runPromise(
      Effect.gen(function* () {
        const callsRef = yield* Ref.make(0)
        const stream = loopPull(0, (n: number) =>
          Stream.unwrap(
            Ref.update(callsRef, (calls) => calls + 1).pipe(
              Effect.as(
                n >= 10
                  ? Stream.fromIterable([n, stopPull])
                  : Stream.fromIterable([n, nextPull(n + 1)]),
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
    const stream = loopPull(0, () => Stream.die(defect))

    const result = await Effect.runPromiseExit(Stream.runCollect(stream))

    expect(result._tag).toBe("Failure")
  })

  it("runs body finalizers when a Decision short-circuits the body", async () => {
    const releases = await Effect.runPromise(
      Effect.gen(function* () {
        const releasesRef = yield* Ref.make<ReadonlyArray<number>>([])
        const stream = loopPull(0, (n: number) =>
          (n >= 1
            ? Stream.fromIterable([n, stopPull])
            : Stream.fromIterable([n, nextPull(n + 1), n + 10])
          ).pipe(
            Stream.ensuring(Ref.update(releasesRef, (values) => [...values, n])),
          ),
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
        const body = (): Stream.Stream<number | typeof stopPull> =>
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(started, undefined).pipe(Effect.as(0))),
            Stream.never,
          ).pipe(Stream.ensuring(Ref.update(releasesRef, (n) => n + 1)))
        const stream = loopPull(0, body)

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
        loopPull(0, (): Stream.Stream<number | typeof stopPull> => {
          throw defect
        }),
      ),
    )

    expect(result._tag).toBe("Failure")
  })
})
