# Spike — streaming tool outputs

## Problem

A tool's `run` returns `Effect<Output>` today. Some tools are naturally
streams (sub-agent that runs its own loop, sandboxed code execution that
emits stdout, web search that re-ranks as sources arrive). Two audiences
care:

- The **model** wants exactly one `FunctionCallOutput` per
  `function_call`. Cardinality is 1:1 by provider contract — can't
  change.
- The **frontend / consumer** wants intermediate events as they happen
  for live UI updates.

Today the loop's stream carries `TurnEvent | A` to the consumer, but
tool execution is a black box `Effect`. The intermediate channel
doesn't exist.

## Streaming is the exception, not the rule

Treat it that way: existing `run: (input) => Effect<Output>` tools
must work unchanged. Only opt-in tools should pay any complexity tax.

## Files

Each option is a self-contained file showing the **same toy tool** —
a "thinker" that emits 3 intermediate "thoughts" and produces a final
answer — with that option's API. The toy lets the API differences show.

- [`option-1-bifurcated.ts`](./option-1-bifurcated.ts) — distinct
  `Tool.streaming` constructor; existing `Tool.make` unchanged. Two
  Tool variants, two execution paths in the toolkit.
- [`option-5-service.ts`](./option-5-service.ts) — `ToolStream` Effect
  Service injected per-call. Tools that want to publish add the dep;
  others ignore. Framework correlates by `call_id`.
- [`option-6-fork-arg.ts`](./option-6-fork-arg.ts) — tool's `run` takes
  an optional second argument (a `ToolContext` with `publish`). No new
  Service abstraction.
- [`option-7-shared-queue.ts`](./option-7-shared-queue.ts) — a single
  per-turn `Queue<ToolEvent>` is created by the loop body, passed to
  the executor, and forwarded to tools that opt in. The queue's stream
  becomes the first leg of `Stream.concat`.

Each file is runnable in isolation against `vitest`. No real provider;
no real LLM. Tests assert what the consumer sees.

## Trade-offs at a glance

| Option | Tool API change          | New core concept | Backwards compat | Per-call vs per-turn |
| ------ | ------------------------ | ---------------- | ---------------- | -------------------- |
| 1      | new `Tool.streaming`     | second tool kind | yes (additive)   | per-call             |
| 5      | optional `R` extension   | `ToolStream` Service | yes (additive) | per-call             |
| 6      | optional second arg      | `ToolContext` shape | mostly (signature widens) | per-call    |
| 7      | optional second arg      | `Queue` parameter on executor | mostly | per-turn |

## What I'm watching for

When you read the four files, the questions to answer:

1. **Ergonomics for tool authors.** Which `run` signature is least
   surprising for someone writing a normal (non-streaming) tool? Which
   for someone writing a streaming one?
2. **Framework correlation.** Does the framework tag intermediate
   events with `call_id`, or does the tool? Which option lets the tool
   stay ignorant of its own `call_id`?
3. **Backpressure default.** Per-call queues are easy to size; per-turn
   shared queues mix events from concurrent tool runs and need more
   thought.
4. **Test layer.** Each option has a different "no-op" provider for
   tests that don't care about events. How heavy is each one?
5. **Future composition.** Sub-agent recipes will want to pull intermediate
   events into the parent loop's stream. Which option makes that
   plumbing shortest?

## Backpressure question (applies to 5, 6, 7)

Three policies for "tool publishes but no consumer pulls":

- **Unbounded queue.** Tool never blocks; memory grows.
- **Bounded with drop-oldest.** Recent progress wins. Good for UI tickers.
- **Bounded with block.** Tool stalls if no consumer.

Default I'd ship: bounded-with-drop-oldest, configurable. Tools should
not stall on cosmetic UI updates. Spike code uses unbounded for
simplicity; the test files don't exercise backpressure.

## Cancellation and scope

If the loop is interrupted mid-tool-stream, the tool fiber must be
interrupted too. Standard Effect scope semantics handle this if the
tool fiber is attached to the loop's scope. None of the options here
exercise interruption — that's a follow-up concern.

## Recommendation order, after writing the spikes

(Filled in after reviewing — see comments at the top of each file.)
