---
title: Recipes
description: Working examples of common agent patterns.
---

Recipes live in [`recipes/`](https://github.com/betalyra/effect-uai/tree/main/recipes)
in the repo. Each one is real, type-checked code composed from core
primitives. Their READMEs are mirrored as pages in this section — the
page _is_ the recipe's `README.md`, sitting next to its `index.ts`,
`index.test.ts`, and `run.ts` in the repo.

For the foundational shapes (a turn with one tool, structured JSON
output), see **Start here** in the sidebar — those are now part of the
core docs flow rather than recipes.

## Tools and HITL

| Recipe                                                              | One-line                                                                                                       |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Tool call approval](/recipes/tool-call-approval/)                  | Pause the loop on sensitive calls; resume on the user's verdict. HTTP + queue variants on the same primitive.  |
| [Streaming tool output](/recipes/streaming-tool-output/)            | Two flavors of `Tool.streaming`: sub-agent text streaming and progress + terminal result.                      |
| [Streaming structured output](/recipes/streaming-structured-output/) | Decode JSONL one object at a time as the model streams; typed per-object Stream, errors in the failure channel. |

## Reliability and lifecycle

| Recipe                                                | One-line                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Multi-model fallback](/recipes/multi-model-fallback/) | Fall back across providers on `RateLimited` / `Unavailable`.                            |
| [Auto-compaction](/recipes/auto-compaction/)          | Summarize history when token / turn budget is exceeded.                                  |
| [Pause and resume](/recipes/pause-resume/)            | Checkpoint after each turn; resume later via `previousResponseId`.                       |
| [Mid-stream abort](/recipes/mid-stream-abort/)        | Cancel the loop and the upstream HTTP request via scope-based cleanup.                   |

## Multi-model

| Recipe                                                | One-line                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Multi-model compare](/recipes/multi-model-compare/)  | Fan one prompt out to OpenAI, Google, and Anthropic concurrently; per-member errors stay isolated.      |
| [Model council](/recipes/model-council/)              | Same fan-out, but each model scores the others' answers and the winner is streamed back.                |
