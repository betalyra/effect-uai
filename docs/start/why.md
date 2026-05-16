---
title: Why effect-uai
description: Why we built effect-uai and when to reach for it.
---

Most agentic AI frameworks ship some form of `streamText` function or
`Agent` class that hides the interaction between SDK and the LLM. This
is nice to get you started, but the abstraction quickly falls apart
when you step out of the happy path. Need to handle errors, fall back
to a different model, decide when to stop? Now you have to hook into
the inner lifecycle of this black box. To make that possible, the SDKs
expose a myriad of callbacks and attributes such as `onError`,
`maxRetries`, `prepareStep`, and so on, so you can patch the inner
lifecycle from the outside.

In our opinion, this is fundamentally the wrong direction and it
doesn't scale. Every AI application has its own quirks and
requirements. We therefore went the opposite way: **make the AI loop
explicit.**

Instead of a one-size-fits-all solution, `effect-uai` gives you
elementary building blocks that help you implement your own agentic
loop, agent harness, or multi-turn chat. Built on `effect`'s
primitives, they are easy to use, understand, and reason about. We
provide recipes for common use-cases like model fallback, automatic
compaction, and model council that you can adapt to your own
application. Think of it as shadcn, but for your AI application.

## What that looks like in practice

- **One turn is one `Stream<TurnEvent>`.** No hidden state machine.
  You see every text delta, reasoning chunk, tool call, and the
  terminal `TurnComplete` event. Pattern-match the events you care
  about, ignore the rest.
- **The loop is a function you call.** `loop` runs a turn, hands you
  the events, and lets _you_ decide whether to continue, stop, swap
  models, compact, or branch. There is no `onStepFinish` callback
  fighting you for control.
- **Providers are interchangeable layers.** OpenAI, Anthropic, and
  Gemini all implement the same `LanguageModel` contract. The
  program shape doesn't change when you swap providers, only the
  layer you provide.
- **Tools are typed Effects.** A tool is an Effect with a schema,
  not a string-keyed callback. Errors, dependencies, and results
  flow through the type system the same way the rest of your Effect
  code does.

## When to reach for it

Reach for `effect-uai` when you want to:

- compose your own agent loop instead of configuring someone else's;
- swap or stack providers without rewriting the program;
- treat tool calls, retries, and fallbacks as ordinary Effect
  composition rather than framework hooks;
- ship the same primitives across server, edge, and browser without
  pulling in every provider SDK.

If you just want a hosted `Agent` that does the right thing by
default, a higher-level framework will get you there faster.
`effect-uai` is the layer underneath.

## Status

`effect-uai` is still experimental. The primitives are stable enough
that we use them, but the surface will keep moving as we learn. We'd
love for you to give it a try and share what works and what doesn't.

## Next step

Head to **[Installation](/start/installation/)** and then
**[One turn is a stream](/start/getting-started/)**.
