---
title: Installation
description: Install the core primitives and exactly the providers you use.
---

`effect-uai` is split around the same boundary your application has:
the agent harness is provider-agnostic, while model vendors are runtime
dependencies.

```sh
pnpm add @effect-uai/core @effect-uai/responses effect
```

`@effect-uai/core` contains the primitives: turns, items, loops, tools,
structured output, and the generic `LanguageModel` contract. Provider
packages implement that contract as Effect layers:

```sh
pnpm add @effect-uai/anthropic
pnpm add @effect-uai/google
```

This keeps the program shape independent from the vendor. Swap OpenAI for
Anthropic or Gemini by changing the layer you provide, not by rewriting your
loop.

## What You Installed

- **`@effect-uai/core`** — the building blocks for your own agent loop.
- **`@effect-uai/responses`** — the OpenAI Responses provider layer.
- **`effect`** — the runtime, streaming, dependency, and error model.

The core package has no provider dependencies, so server, edge, and browser
builds only pull in the providers you actually use.

## Teach Your Coding Agent

If you build with an AI coding agent (Claude Code, Cursor, Continue, …),
install the agent skills bundle so the agent learns the philosophy,
primitives, and recipe patterns:

```sh
npx skills add betalyra/effect-uai
```

One main skill plus fourteen recipe sub-skills, loaded lazily —
[Skills](/skills/) has the catalog and per-skill install commands.

Next: [stream one model turn](/start/getting-started/).
