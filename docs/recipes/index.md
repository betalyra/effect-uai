---
title: Recipes
description: Working examples of common agent patterns.
---

Recipes are variations of the same harness: state is a record, one turn is a
stream, and the loop decides what happens next.

Each recipe shows one design move you can copy into your own agent: gate tool
calls before execution, stream inner work, catch provider failures, rewrite
history, pause between turns, or fan out to multiple models. They are real,
type-checked code in [`recipes/`](https://github.com/betalyra/effect-uai/tree/main/recipes),
and each page mirrors the `README.md` sitting next to its `index.ts` and tests.

For the foundational shapes, start with [One turn is a stream](/start/getting-started/),
[Basic usage](/recipes/basic-usage/), and [Structured output](/recipes/structured-output/).

## Tools and HITL

| Recipe                                                               | One-line                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [Tool call approval](/recipes/tool-call-approval/)                   | Gate sensitive calls before `executeAll`; still return one result per model-requested tool call. |
| [Streaming tool output](/recipes/streaming-tool-output/)             | Show inner tool work to the user while returning one clean output to the model.                  |
| [Streaming structured output](/recipes/streaming-structured-output/) | Validate prompted JSONL one object at a time as the model streams.                               |

## Reliability and lifecycle

| Recipe                                                 | One-line                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| [Multi-model fallback](/recipes/multi-model-fallback/) | Recover from provider stream failures by advancing to the next tier.                                              |
| [Model retry](/recipes/model-retry/)                   | Add retry policy around one model stream; only transient provider failures get another try.                       |
| [Auto-compaction](/recipes/auto-compaction/)           | Rewrite oversized history as an ordinary state transition.                                                        |
| [Pause and resume](/recipes/pause-resume/)             | Pause between loop iterations with a latch; no provider call remains open.                                        |
| [Mid-stream abort](/recipes/mid-stream-abort/)         | Cancel an in-flight turn through stream interruption and scope cleanup.                                           |
| [Agentic loop](/recipes/agentic-loop/)                 | Drive a long-lived chat from a user-message queue while continuing model/tool work between clean turn boundaries. |

## Transport

| Recipe                                                 | One-line                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [Modify output stream](/recipes/modify-output-stream/) | Keep the loop transport-agnostic; project typed turn events into SSE or JSONL at the edge. |

## Multi-model

| Recipe                                               | One-line                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| [Multi-model compare](/recipes/multi-model-compare/) | Fan one prompt out to multiple providers; per-member errors stay isolated.     |
| [Model council](/recipes/model-council/)             | Build a stream graph where models answer, judge each other, and emit a winner. |
