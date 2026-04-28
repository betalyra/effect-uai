# @betalyra/effect-uai

_/ˈi.fɛkt ˈwaj/ — "effect-why"_

> **_Uai_** \\ wai \\ — Mineiro Portuguese, all-purpose interjection.

A small, explicit AI/LLM toolkit for Effect.

You write the loop. There's no agent runtime — just a handful of small pieces to put together.

## Design decisions

- 👀 **The loop is yours.** No hidden agent runtime — you write the multi-turn flow.
- 🧩 **Reuse Effect, don't reinvent.** Retries, error handling, concurrency, cancellation, timing all come from Effect.
- 🎒 **State is whatever you want.** History, model, budget, retries — your shape, your choice.
- 🌊 **Streaming first, blocking is just a drain.** One primitive, no two APIs to keep in sync.
- ⚙️ **One turn is mechanical, many turns is policy.** The library owns the wire; you own the decision.
- 🪞 **Messages mirror the OpenAI Responses API.** No invented in-between format.
- 🛡️ **Validation lives where it matters.** Provider rules at the provider boundary, not in your loop.
- 🏷️ **Typed errors.** Every failure is tagged so you can catch what you mean.
- 🔄 **Models are values, swap them per call.** No special API for switching.
- 📋 **Recipes over helpers.** Copy a snippet, don't import a tower of abstractions.
- 📈 **Metrics are just stream operators.** No telemetry framework, no callbacks.

## Status

⚠️ Early stage concept. Use at your own risk.

```bash
pnpm test       # vitest run
pnpm typecheck  # tsc
```
