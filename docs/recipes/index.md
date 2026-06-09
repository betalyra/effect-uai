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

| Recipe                                                               | One-line                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Tool call approval](/recipes/tool-call-approval/)                   | Gate sensitive calls before `Toolkit.run`; still return one result per model-requested tool call. |
| [Streaming tool output](/recipes/streaming-tool-output/)             | Show inner tool work to the user while returning one clean output to the model.                   |
| [Streaming structured output](/recipes/streaming-structured-output/) | Validate prompted JSONL one object at a time as the model streams.                                |

## Reliability and lifecycle

| Recipe                                                 | One-line                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| [Multi-model fallback](/recipes/multi-model-fallback/) | Recover from provider stream failures by advancing to the next tier.                                              |
| [Model retry](/recipes/model-retry/)                   | Add retry policy around one model stream; only transient provider failures get another try.                       |
| [Auto-compaction](/recipes/auto-compaction/)           | Rewrite oversized history as an ordinary state transition.                                                        |
| [Pause and resume](/recipes/pause-resume/)             | Pause between loop iterations with a latch; no provider call remains open.                                        |
| [Mid-stream abort](/recipes/mid-stream-abort/)         | Cancel an in-flight turn through stream interruption and scope cleanup.                                           |
| [Agentic loop](/recipes/agentic-loop/)                 | Drive a long-lived chat from a user-message queue while continuing model/tool work between clean turn boundaries. |
| [Sleeper agent](/recipes/sleeper-agent/)               | Wait for a long-running tool call — the agent goes quiet while the work runs and wakes up when it's done.         |

## Transport

| Recipe                                                 | One-line                                                                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [Modify output stream](/recipes/modify-output-stream/) | Keep the loop transport-agnostic; project typed turn events into SSE or JSONL at the edge. |

## Multi-model

| Recipe                                               | One-line                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Model escalation](/recipes/model-escalation/)       | Start on a fast cheap model; let it escalate hard questions to a stronger tier via a tool call. |
| [Multi-model compare](/recipes/multi-model-compare/) | Fan one prompt out to multiple providers; per-member errors stay isolated.                      |
| [Model council](/recipes/model-council/)             | Build a stream graph where models answer, judge each other, and emit a winner.                  |

## Web search

| Recipe                                       | One-line                                                                                                          |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [Grounded answer](/recipes/grounded-answer/) | Answer a current-events question from live web search with inline citations; swap the LLM and backend at will.    |
| [Deep research](/recipes/deep-research/)     | Plan a broad question into sub-questions, investigate each with a streaming sub-agent, synthesize a cited report. |

## Speech

| Recipe                                                       | One-line                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [Basic transcription](/recipes/basic-transcription/)         | Transcribe a file via the generic Transcriber service; swap providers with `--provider`.            |
| [Basic speech synthesis](/recipes/basic-speech-synthesis/)   | Synthesize a phrase via the generic SpeechSynthesizer service; sync or chunked-streaming mode.      |
| [Streaming transcription](/recipes/streaming-transcription/) | Live mic → transcript over WebSocket; Bun server bridges browser AudioWorklet to provider realtime. |
| [Streaming synthesis](/recipes/streaming-synthesis/)         | Type text → audio plays as the first chunk arrives; incremental text-in over WS.                    |
| [Voice loop](/recipes/voice-loop/)                           | Full STT → LLM → TTS pipeline with stop-word interrupt and follow-up queueing; one fiber per turn.  |

## Music

| Recipe                                                     | One-line                                                                                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Basic music generation](/recipes/basic-music-generation/) | Generate a 30-second clip with Lyria 3; simple prompt or weighted prompts with lyrics and BPM hints.                                                   |
| [Radio station](/recipes/radio-station/)                   | Run your own AI radio station. An AI DJ writes the next track while you listen to the current one; the same set replays for free after the first pass. |

## Sandboxes

| Recipe                                                 | One-line                                                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| [Run, fix, repeat](/recipes/sandbox-code-interpreter/) | LLMs are bad at exact computation — give them Python. Tracebacks from a sandboxed microVM feed back into the next turn. |
