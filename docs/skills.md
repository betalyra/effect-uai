---
title: Skills
description: Drop-in skills that teach your AI coding agent the effect-uai primitives, provider wiring, and recipe patterns.
---

`effect-uai` ships a bundle of [agent skills](https://agentskills.io)
for AI coding agents (Claude Code, Cursor, Continue, …). One main
skill covers the philosophy, primitives, and provider wiring; fourteen
recipe sub-skills each carry one loop-body pattern. The agent only
loads a skill when its description matches your prompt.

## Install

Via the [skills.sh](https://skills.sh) CLI:

```sh
npx skills add betalyra/effect-uai
```

Cherry-pick a single skill instead:

```sh
npx skills add betalyra/effect-uai/tree/main/skills/effect-uai-model-retry
```

## What loads when

The main skill (`effect-uai`) loads on broad signals like _"I'm
building an AI agent in Effect"_. Recipe sub-skills load on specific
scenarios:

| When you ask for…                                 | Skill                                    |
| ------------------------------------------------- | ---------------------------------------- |
| An agent that can call tools                      | `effect-uai-basic-usage`                 |
| Typed JSON output / fill a form                   | `effect-uai-structured-output`           |
| Stream typed objects as the model writes them     | `effect-uai-streaming-structured-output` |
| Human approval for sensitive tool calls           | `effect-uai-tool-call-approval`          |
| Show progress while a tool runs                   | `effect-uai-streaming-tool-output`       |
| Long-lived chat agent with a queue                | `effect-uai-agentic-loop`                |
| Retry rate limits / 5xx with exponential backoff  | `effect-uai-model-retry`                 |
| Fall back from one provider to another            | `effect-uai-multi-model-fallback`        |
| Summarize history when it gets too long           | `effect-uai-auto-compaction`             |
| Pause the loop between turns and resume later     | `effect-uai-pause-resume`                |
| Stop button / abort the current response          | `effect-uai-mid-stream-abort`            |
| Compare answers from multiple models side-by-side | `effect-uai-multi-model-compare`         |
| Models judge each other and pick a winner         | `effect-uai-model-council`               |
| Stream the output as SSE / JSONL                  | `effect-uai-modify-output-stream`        |

Source and per-skill bodies live in
[`skills/`](https://github.com/betalyra/effect-uai/tree/main/skills).
