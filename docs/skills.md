---
title: Skills
description: A drop-in skill that teaches your AI coding agent the effect-uai primitives, provider wiring, and recipe library.
---

`effect-uai` ships an [agent skill](https://agentskills.io) for AI coding
agents (Claude Code, Cursor, Continue, …). It covers the philosophy,
primitives, and provider wiring, and points the agent at the
[recipe library](/recipes/) for the pattern that fits your prompt. The
agent only loads the skill when its description matches.

## Install

Via the [skills.sh](https://skills.sh) CLI:

```sh
npx skills add betalyra/effect-uai
```

## How it works

The skill loads on broad signals like _"I'm building an AI agent in
Effect"_ or _"wire up the LanguageModel service."_ From there it
recommends the matching recipe and composes patterns in the loop body.

Rather than a separate skill per recipe, the skill carries a scenario
catalog that maps your goal to a recipe under [`recipes/`](/recipes/); the
agent opens that recipe (its `README.md` walkthrough plus `recipe.ts` /
`app.ts` / `run-*.ts` code) and adapts it. New recipes are available to
the agent the moment they land, with no new skill to publish.

Source lives in
[`skills/`](https://github.com/betalyra/effect-uai/tree/main/skills).
