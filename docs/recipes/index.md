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
and each page mirrors the `README.md` sitting next to its `recipe.ts`,
`app.ts` and `run.ts`.

Every recipe has the same four files: `recipe.ts` holds the effect-uai logic
and names capability tags rather than vendors, `app.ts` composes it (flags,
provider Layers, rendering), `run.ts` is one line and works unchanged on Node,
Bun and Deno, and `README.md` is the page you are reading. Run any of them
with `pnpm tsx recipes/<name>/run.ts`, `bun recipes/<name>/run.ts`, or
`deno run --allow-all recipes/<name>/run.ts`.

For the foundational shapes, start with [One turn is a stream](/start/getting-started/),
[Basic usage](/recipes/basic-usage/), and [Structured output](/recipes/structured-output/).

## Tools and HITL

| Recipe                                                               | One-line                                                                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Tool call approval](/recipes/tool-call-approval/)                   | Gate sensitive calls before `Toolkit.run`; still return one result per model-requested tool call.    |
| [Streaming tool output](/recipes/streaming-tool-output/)             | Show inner tool work to the user while returning one clean output to the model.                      |
| [Streaming structured output](/recipes/streaming-structured-output/) | Validate prompted JSONL one object at a time as the model streams.                                   |
| [MCP tools](/recipes/mcp-tools/)                                     | Turn a live MCP server's tools into a `Toolkit`; the connection lives exactly as long as the stream. |

## Reliability and lifecycle

| Recipe                                                 | One-line                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| [Multi-model fallback](/recipes/multi-model-fallback/) | Recover from provider stream failures by advancing to the next tier.                                              |
| [Model retry](/recipes/model-retry/)                   | Add retry policy around one model stream; only transient provider failures get another try.                       |
| [Auto-compaction](/recipes/auto-compaction/)           | Rewrite oversized history as an ordinary state transition.                                                        |
| [Pause and resume](/recipes/pause-resume/)             | Pause between loop iterations with a latch; no provider call remains open.                                        |
| [Mid-stream abort](/recipes/mid-stream-abort/)         | Cancel an in-flight turn through stream interruption and scope cleanup.                                           |
| [Agentic loop](/recipes/agentic-loop/)                 | Drive a long-lived chat from a user-message queue while continuing model/tool work between clean turn boundaries. |
| [Sleeper agent](/recipes/sleeper-agent/)               | Wait for a long-running tool call. The agent goes quiet while the work runs and wakes up when it's done.          |

## Observability

| Recipe                                   | One-line                                                                                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [Basic metrics](/recipes/basic-metrics/) | Stack time-to-first-token, throughput, token totals, and completion time onto a generation; log them live while the story streams to a file. |

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

| Recipe                                                 | One-line                                                                                                                            |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| [Grounded answer](/recipes/grounded-answer/)           | Answer a current-events question from live web search with inline citations; swap the LLM and backend at will.                      |
| [Deep research](/recipes/deep-research/)               | Plan a broad question into sub-questions, investigate each with a streaming sub-agent, synthesize a cited report.                   |
| [Native deep research](/recipes/native-deep-research/) | Submit one question to a provider-hosted research agent (OpenAI, Perplexity, Gemini); stream its progress and get one cited report. |

## Web reading

| Recipe                                 | One-line                                                                                                                                                             |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Market intel](/recipes/market-intel/) | Read a batch of vendor pages to clean markdown and extract a typed pricing record from each, concurrently; no selectors, so pages that share no layout still decode. |

## Retrieval

| Recipe                                                 | One-line                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Retrieve and rerank](/recipes/retrieve-and-rerank/)   | Your top results are about the question but never answer it. Add a rerank pass and watch the right document climb.                                            |
| [Agentic search](/recipes/agentic-search/)             | Give an agent search that catches exact names and paraphrases both, and let it search again when the first try misses. No server.                             |
| [Contextual retrieval](/recipes/contextual-retrieval/) | Chunks that say "he" and "that house" never match a question naming either. Write one line of context per chunk at indexing time, and measure the difference. |

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

## Images

| Recipe                                                           | One-line                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [Storyboard](/recipes/storyboard/)                               | Tell a story in pictures: your characters stay themselves across every panel, so eight images read as one comic.                |
| [Conversational image edit](/recipes/conversational-image-edit/) | Say what to change, keep the picture. Getting the image you want takes a few goes, and your subject survives every one of them. |

## Sandboxes

| Recipe                                                 | One-line                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| [Run, fix, repeat](/recipes/sandbox-code-interpreter/) | LLMs are bad at exact computation. Give them Python. Tracebacks from a sandboxed microVM feed back into the next turn. |

## Browser

| Recipe                                                 | One-line                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| [Agent usability testing](/recipes/browser-usability/) | Give an agent a goal and a URL; it drives the site like a first-time visitor and reports where the UX tripped it up. |
| [Dashboard briefing](/recipes/dashboard-briefing/)     | Screenshot a dashboard whose charts only exist client-side and decode one vision turn into a typed briefing.         |
