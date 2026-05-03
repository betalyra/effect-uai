/**
 * Same toy scenario - "thinker" emits 3 thoughts and a final answer -
 * exercised against each option's API. Verifies each option produces
 * the same observable behavior to the consumer:
 *
 *   3 intermediate events (in order) followed by 1 terminal output
 *   that decodes to `{ answer: "..." }`.
 */
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it } from "vitest";
import * as Items from "@effect-uai/core/Items";
import * as Tool from "@effect-uai/core/Tool";

import * as Option1 from "./option-1-bifurcated.js";
import * as Option5 from "./option-5-service.js";
import * as Option6 from "./option-6-fork-arg.js";
import * as Option7 from "./option-7-shared-queue.js"
import * as Option7Realtime from "./option-7-realtime.js"
import * as Option8 from "./option-8-always-stream.js";

const fc = (
  call_id: string,
  name: string,
  args: unknown,
): Items.FunctionCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: JSON.stringify(args),
});

const expectThoughtsThenAnswer = (
  events: ReadonlyArray<unknown>,
  intermediateCount: number,
): { final: { answer: string } } => {
  expect(events).toHaveLength(intermediateCount + 1);
  const intermediates = events.slice(0, intermediateCount);
  intermediates.forEach((e: any) => {
    expect(e).toMatchObject({ _tag: "Intermediate" });
    expect((e.data as { thought: string }).thought).toMatch(
      /considering|almost there|finalizing/,
    );
  });
  const last = events[events.length - 1] as any;
  expect(last._tag).toBe("Output");
  const final = JSON.parse(last.output.output) as { answer: string };
  expect(final.answer).toMatch(/42/);
  return { final };
};

describe("Option 1 - bifurcated Tool.streaming", () => {
  it("emits 3 intermediates then a terminal Output whose JSON is the model-facing answer", async () => {
    const call = fc("c1", "thinker", { question: "ultimate" });
    const stream = Option1.execute(Option1.thinker, call);
    const events = await Effect.runPromise(Stream.runCollect(stream));
    expectThoughtsThenAnswer(events, 3);
  });
});

describe("Option 5 - ToolStream service", () => {
  describe("default path (executeOne) - no queue, no streaming", () => {
    it("non-streaming tool runs as today's Effect<FunctionCallOutput>", async () => {
      const call = fc("c1", "echo", { text: "hello" });
      const output = await Effect.runPromise(
        Option5.executeOne(Option5.echo, call),
      );
      expect(output.call_id).toBe("c1");
      expect(JSON.parse(output.output)).toEqual({ echoed: "hello" });
    });

    it("streaming-aware tool also runs - publishes vanish into the no-op layer", async () => {
      // Same `thinker` tool that yields ToolStream and calls publish 3 times.
      // In the default path, publishes go to layerNoop. The tool returns
      // its terminal value identically; no events are observable.
      const call = fc("c1", "thinker", { question: "ultimate" });
      const output = await Effect.runPromise(
        Option5.executeOne(Option5.thinker, call),
      );
      expect(JSON.parse(output.output)).toEqual({
        answer: 'The answer to "ultimate" is 42.',
      });
    });
  });

  describe("streaming path (executeOneStreaming) - opt-in queue + intermediates", () => {
    it("streaming-aware tool emits 3 intermediates then a terminal Output", async () => {
      const call = fc("c1", "thinker", { question: "ultimate" });
      const stream = Option5.executeOneStreaming(Option5.thinker, call);

      const events = await Effect.runPromise(Stream.runCollect(stream));
      expectThoughtsThenAnswer(events, 3);
    });
  });

  describe("mixed-turn streaming (executeAllSafeStreaming) - the loop body's actual API", () => {
    it("a turn with both streaming and non-streaming tools: one queue, mixed events", async () => {
      // Toolkit has one of each. The recipe builds the loop body around
      // executeAllSafeStreaming. Non-streaming `echo` never touches the
      // queue; streaming `thinker` publishes 3 intermediates. Both
      // produce a terminal FunctionCallOutput.
      const toolkit = [Option5.thinker, Option5.echo] as Parameters<
        typeof Option5.executeAllSafeStreaming
      >[0];
      const calls = [
        fc("c1", "thinker", { question: "ultimate" }),
        fc("c2", "echo", { text: "hello" }),
      ];
      const stream = Option5.executeAllSafeStreaming(toolkit, calls);
      const events = await Effect.runPromise(Stream.runCollect(stream));

      const intermediates = events.filter(
        (e): e is Extract<Option5.ConsumerEvent, { _tag: "Intermediate" }> =>
          e._tag === "Intermediate",
      );
      // Only the streaming tool produced intermediates, all tagged with c1.
      expect(intermediates).toHaveLength(3);
      intermediates.forEach((e) => expect(e.call_id).toBe("c1"));

      const outputs = events.filter(
        (e): e is Extract<Option5.ConsumerEvent, { _tag: "Output" }> =>
          e._tag === "Output",
      );
      // Both tools produced terminal outputs - thinker AND echo.
      expect(outputs).toHaveLength(2);
      const callIds = outputs.map((o) => o.output.call_id).sort();
      expect(callIds).toEqual(["c1", "c2"]);

      const echoOutput = outputs.find((o) => o.output.call_id === "c2")!;
      expect(JSON.parse(echoOutput.output.output)).toEqual({ echoed: "hello" });
    });
  });
});

describe("Option 6 - publish as second arg", () => {
  it("emits 3 intermediates (via ctx.publish) then a terminal Output", async () => {
    const call = fc("c1", "thinker", { question: "ultimate" });
    const stream = Option6.execute(Option6.thinker, call);
    const events = await Effect.runPromise(Stream.runCollect(stream));
    expectThoughtsThenAnswer(events, 3);
  });

  it("non-streaming tools that ignore the ctx arg work unchanged", async () => {
    const call = fc("c1", "echo", { text: "hi" });
    const stream = Option6.execute(Option6.echo, call);
    const events = await Effect.runPromise(Stream.runCollect(stream));
    expect(events).toHaveLength(1);
    expect(JSON.parse((events[0] as any).output.output)).toEqual({
      echoed: "hi",
    });
  });
});

describe("Option 7 - closure capture (revised)", () => {
  it("streaming tool publishes via closure; non-streaming tool runs unchanged; events concat outputs", async () => {
    const calls = [
      fc("c1", "thinker", { question: "ultimate" }),
      fc("c2", "echo", { text: "hello" }),
    ]
    const { events, outputs } = await Effect.runPromise(Option7.runTurn(calls))

    // outputs is a normal array, ready for the recipe's state update.
    expect(outputs).toHaveLength(2)
    const callIds = outputs.map((o) => o.call_id).sort()
    expect(callIds).toEqual(["c1", "c2"])

    // Drain the events stream.
    const collected = await Effect.runPromise(Stream.runCollect(events))

    // Intermediates first (3, all from `thinker`), outputs last (2).
    const intermediates = collected.filter(
      (e): e is Option7.ThinkerEvent => "tool" in e && (e as { tool: string }).tool === "thinker",
    )
    expect(intermediates).toHaveLength(3)
    expect(intermediates.map((e) => e.thought)).toEqual([
      "considering...",
      "almost there...",
      "finalizing...",
    ])

    const outputItems = collected.filter(
      (e): e is Items.FunctionCallOutput => "type" in e && e.type === "function_call_output",
    )
    expect(outputItems).toHaveLength(2)

    // Order: intermediates BEFORE outputs (Stream.concat semantics).
    const firstOutputIndex = collected.findIndex(
      (e) => "type" in e && e.type === "function_call_output",
    )
    const lastIntermediateIndex =
      collected.length -
      1 -
      [...collected].reverse().findIndex((e) => "tool" in e && !("type" in e))
    expect(lastIntermediateIndex).toBeLessThan(firstOutputIndex)
  })

  it("multiple `thinker` calls in one turn: 6 intermediates, 2 outputs", async () => {
    const calls = [
      fc("c1", "thinker", { question: "first" }),
      fc("c2", "thinker", { question: "second" }),
    ]
    const { events, outputs } = await Effect.runPromise(Option7.runTurn(calls))

    expect(outputs).toHaveLength(2)

    const collected = await Effect.runPromise(Stream.runCollect(events))
    const intermediates = collected.filter(
      (e): e is Option7.ThinkerEvent => "tool" in e && !("type" in e),
    )
    expect(intermediates).toHaveLength(6) // 3 thoughts × 2 calls

    const outputItems = collected.filter(
      (e): e is Items.FunctionCallOutput => "type" in e && e.type === "function_call_output",
    )
    expect(outputItems).toHaveLength(2)
  })

  it("turn with only non-streaming tools: no intermediates, just outputs", async () => {
    const calls = [
      fc("c1", "echo", { text: "alpha" }),
      fc("c2", "echo", { text: "beta" }),
    ]
    const { events, outputs } = await Effect.runPromise(Option7.runTurn(calls))

    expect(outputs).toHaveLength(2)

    const collected = await Effect.runPromise(Stream.runCollect(events))
    const intermediates = collected.filter(
      (e): e is Option7.ThinkerEvent => "tool" in e && !("type" in e),
    )
    expect(intermediates).toHaveLength(0)

    const outputItems = collected.filter(
      (e): e is Items.FunctionCallOutput => "type" in e && e.type === "function_call_output",
    )
    expect(outputItems).toHaveLength(2)
  })
})

describe("Option 7 - real-time variant (drainFork)", () => {
  it("collects all events in order: 3 intermediates then 1 output, single stream", async () => {
    const calls = [fc("c1", "thinker", { question: "ultimate" })]
    // Tiny delay so the test is fast; correctness still holds.
    const stream = Option7Realtime.runTurnRealtime(calls, { delay: "5 millis" })
    const collected = await Effect.runPromise(Stream.runCollect(stream))

    const intermediates = collected.filter(
      (e): e is Option7Realtime.ThinkerEvent => "tool" in e && !("type" in e),
    )
    expect(intermediates).toHaveLength(3)
    expect(intermediates.map((e) => e.thought)).toEqual([
      "considering...",
      "almost there...",
      "finalizing...",
    ])

    const outputs = collected.filter(
      (e): e is Items.FunctionCallOutput => "type" in e && e.type === "function_call_output",
    )
    expect(outputs).toHaveLength(1)
    expect(JSON.parse(outputs[0]!.output)).toMatchObject({
      answer: expect.stringMatching(/42/),
    })
  })

  it("intermediates arrive WHILE the tool is running, not after - real-time check", async () => {
    // Slow thinker takes ~3 * 100ms = 300ms total. With drainFork, we
    // should see the first thought ~immediately and the second after
    // ~100ms. With buffered execution the consumer would see nothing
    // until the entire 300ms+ run completes.
    const calls = [fc("c1", "thinker", { question: "ultimate" })]
    const stream = Option7Realtime.runTurnRealtime(calls, { delay: "100 millis" })

    const start = Date.now()

    // Take only the first 2 intermediates. Stream.take cancels the
    // upstream after N elements, so the driver is interrupted mid-tool.
    const firstTwo = await Effect.runPromise(
      stream.pipe(Stream.take(2), Stream.runCollect),
    )

    const elapsed = Date.now() - start

    // We got the first 2 events.
    expect(firstTwo).toHaveLength(2)
    expect(firstTwo.every((e) => "tool" in e && !("type" in e))).toBe(true)

    // First thought is offered before any sleep, so it arrives ~immediately.
    // Second thought arrives after the first 100ms delay.
    // If the implementation were buffered, elapsed would be >= 300ms.
    // drainFork: should be in [100ms, 250ms] band.
    expect(elapsed).toBeLessThan(250)
  })

  it("mixed turn (1 streaming + 1 non-streaming): both outputs land, intermediates only from thinker", async () => {
    const calls = [
      fc("c1", "thinker", { question: "ultimate" }),
      fc("c2", "echo", { text: "hello" }),
    ]
    const stream = Option7Realtime.runTurnRealtime(calls, { delay: "5 millis" })
    const collected = await Effect.runPromise(Stream.runCollect(stream))

    const intermediates = collected.filter(
      (e): e is Option7Realtime.ThinkerEvent => "tool" in e && !("type" in e),
    )
    expect(intermediates).toHaveLength(3) // only thinker emits intermediates

    const outputs = collected.filter(
      (e): e is Items.FunctionCallOutput => "type" in e && e.type === "function_call_output",
    )
    expect(outputs).toHaveLength(2)
    const callIds = outputs.map((o) => o.call_id).sort()
    expect(callIds).toEqual(["c1", "c2"])

    const echoOutput = outputs.find((o) => o.call_id === "c2")!
    expect(JSON.parse(echoOutput.output)).toEqual({ echoed: "hello" })
  })
})

describe("Option 8 - executeAllSafe returns Stream<ToolEvent>, real-time", () => {
  it("streaming tool: stream contains 3 intermediates + 1 Output", async () => {
    const calls = [fc("c1", "thinker", { question: "ultimate" })]
    const collected = await Effect.runPromise(
      Stream.runCollect(Option8.executeAllSafe([Option8.thinker, Option8.echo], calls)),
    )

    const intermediates = collected.filter(Option8.isIntermediate)
    expect(intermediates).toHaveLength(3)
    intermediates.forEach((e) => {
      expect(e.call_id).toBe("c1")
      expect(e.tool).toBe("thinker")
    })

    const outputs = collected.filter(Option8.isOutput)
    expect(outputs).toHaveLength(1)
    const parsed = JSON.parse(outputs[0]!.output.output) as {
      answer: string
      thoughts: ReadonlyArray<string>
    }
    expect(parsed.thoughts).toHaveLength(3)
    expect(parsed.answer).toMatch(/finalizing/)
  })

  it("non-streaming tool: just one Output, no intermediates", async () => {
    const calls = [fc("c1", "echo", { text: "hello" })]
    const collected = await Effect.runPromise(
      Stream.runCollect(Option8.executeAllSafe([Option8.thinker, Option8.echo], calls)),
    )

    expect(collected).toHaveLength(1)
    expect(collected[0]!._tag).toBe("Output")
    const out = collected.filter(Option8.isOutput)[0]!
    expect(JSON.parse(out.output.output)).toEqual({ echoed: "hello" })
  })

  it("mixed turn: streaming tool's intermediates + both tools' Outputs", async () => {
    const calls = [
      fc("c1", "thinker", { question: "everything" }),
      fc("c2", "echo", { text: "hi" }),
    ]
    const collected = await Effect.runPromise(
      Stream.runCollect(Option8.executeAllSafe([Option8.thinker, Option8.echo], calls)),
    )

    const intermediates = collected.filter(Option8.isIntermediate)
    expect(intermediates).toHaveLength(3) // only thinker emits

    const outputs = collected.filter(Option8.isOutput)
    expect(outputs).toHaveLength(2)
    const callIds = outputs.map((e) => e.output.call_id).sort()
    expect(callIds).toEqual(["c1", "c2"])
  })

  it("pattern 2 - recipe streamer: events ARE recipes, finalize wraps as a list", async () => {
    const calls = [fc("c1", "recipe_streamer", { cuisine: "Portuguese" })]
    const collected = await Effect.runPromise(
      Stream.runCollect(Option8.executeAllSafe([Option8.recipeStreamer], calls)),
    )

    const intermediates = collected.filter(Option8.isIntermediate)
    expect(intermediates).toHaveLength(3)
    intermediates.forEach((e) => {
      const recipe = e.data as Option8.Recipe
      expect(recipe.title).toMatch(/Portuguese/)
      expect(typeof recipe.time_minutes).toBe("number")
    })

    const outputs = collected.filter(Option8.isOutput)
    expect(outputs).toHaveLength(1)
    const parsed = JSON.parse(outputs[0]!.output.output) as Option8.RecipeListOutput
    expect(parsed.recipes).toHaveLength(3)
    expect(parsed.recipes[0]!.title).toMatch(/Portuguese starter/)
  })

  it("pattern 3 - slow download: progress events flow through, finalize picks the result", async () => {
    const calls = [fc("c1", "slow_download", { url: "example.com/file" })]
    const collected = await Effect.runPromise(
      Stream.runCollect(Option8.executeAllSafe([Option8.slowDownload], calls)),
    )

    const intermediates = collected.filter(Option8.isIntermediate)
    expect(intermediates).toHaveLength(4)
    const progressEvents = intermediates.filter(
      (e) => (e.data as Option8.DownloadEvent).type === "progress",
    )
    expect(progressEvents).toHaveLength(3)

    const outputs = collected.filter(Option8.isOutput)
    expect(outputs).toHaveLength(1)
    const parsed = JSON.parse(outputs[0]!.output.output) as Option8.DownloadOutput
    expect(parsed.status).toBe("completed")
    expect(parsed.bytes).toBe("bytes-of-example.com/file")
  })

  it("intermediates arrive WHILE the tool is running, not after - real-time check", async () => {
    // Inline slow streaming tool: 3 thoughts with 100ms delays between them.
    // Total run takes ~300ms. If executeAllSafe were still using runCollect,
    // the consumer would see nothing until after 300ms. With the Ref+concat
    // pattern, intermediates flow through immediately.
    const SlowInput = Schema.Struct({ q: Schema.String })
    const slow = Option8.streaming({
      name: "slow",
      description: "slow streaming tool",
      inputSchema: Tool.fromEffectSchema(SlowInput),
      run: () =>
        Stream.unfold(0, (i: number) =>
          i >= 3
            ? Effect.succeed(undefined)
            : Effect.delay(
                Effect.succeed([{ thought: `t${i}` }, i + 1] as const),
                "100 millis",
              ),
        ),
      finalize: (events) => ({ count: events.length }),
      strict: true,
    })

    const calls = [fc("c1", "slow", { q: "x" })]
    const start = Date.now()

    // Take only the first 2 intermediates. If buffered, we'd wait ~300ms.
    const firstTwo = await Effect.runPromise(
      Option8.executeAllSafe([slow], calls).pipe(Stream.take(2), Stream.runCollect),
    )

    const elapsed = Date.now() - start

    expect(firstTwo).toHaveLength(2)
    expect(firstTwo.every(Option8.isIntermediate)).toBe(true)
    // Each event takes 100ms; getting 2 should be ~200ms, not 300ms+.
    expect(elapsed).toBeLessThan(280)
  })

  it("concurrent calls: two slow tools run in parallel, not sequentially", async () => {
    // Each call sleeps 200ms then emits one event + Output. Sequential would
    // take ~400ms; parallel should finish in ~200ms.
    const SlowInput = Schema.Struct({ q: Schema.String })
    const slow = Option8.streaming({
      name: "slow",
      description: "slow",
      inputSchema: Tool.fromEffectSchema(SlowInput),
      run: ({ q }) =>
        Stream.fromEffect(Effect.delay(Effect.succeed({ q }), "200 millis")),
      finalize: (events) => ({ done: events.length }),
      strict: true,
    })

    const calls = [fc("c1", "slow", { q: "a" }), fc("c2", "slow", { q: "b" })]
    const start = Date.now()
    const collected = await Effect.runPromise(
      Stream.runCollect(Option8.executeAllSafe([slow], calls)),
    )
    const elapsed = Date.now() - start

    expect(collected.filter(Option8.isOutput)).toHaveLength(2)
    // Sequential: ~400ms. Parallel: ~200ms. Allow generous slack.
    expect(elapsed).toBeLessThan(350)
  })

  it("recipe shape: nextStateFrom builds Loop events without exposing a Ref", async () => {
    interface State {
      readonly history: ReadonlyArray<Items.Item>
    }
    const initialHistory: ReadonlyArray<Items.Item> = [Items.userText("...")]

    const calls = [fc("c1", "thinker", { question: "test" })]

    const stream = Option8.nextStateFrom(
      Option8.executeAllSafe([Option8.thinker, Option8.echo], calls),
      (outputs): State => ({ history: [...initialHistory, ...outputs] }),
    )

    // 3 Intermediate Values + 1 Output Value + 1 Next.
    const continuationEvents = await Effect.runPromise(Stream.runCollect(stream))
    expect(continuationEvents).toHaveLength(5)

    const last = continuationEvents[continuationEvents.length - 1]!
    expect(last._tag).toBe("Next")
    if (last._tag === "Next") {
      const state = last.state as State
      expect(state.history).toHaveLength(2)
      expect(state.history[1]!.type).toBe("function_call_output")
    }
  })
})
