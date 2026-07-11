---
title: Native deep research
description: Turn a broad question into a cited report without building the agent. Submit it to a provider that runs the whole research job server-side and hand back one report you can read and cite.
source: recipes/native-deep-research
icon: PiAtom
---

Some questions are too broad for one search. "Compare the leading X for Y",
"what's the state of Z": answering them well means running dozens of searches
across many angles and pulling the threads into one report. You could build
that agent yourself, but some providers already ship it as an API. You submit
one question, they run the whole research job on their side for minutes, and
you get back a long report with inline citations.

This is the provider-hosted counterpart to
[deep research](/recipes/deep-research/), which hand-rolls the agent
(`plan -> fanOut -> synthesize`) over the generic `LanguageModel` + `WebSearch`
tags. Same result, opposite trade: there you own the loop and every step;
here you make a single call and the provider owns the agent.

## Stream the run, then read the report

A run lasts minutes, so the recipe streams what the agent is doing (searches,
reasoning, text as it lands) instead of blocking on a silent wait. It runs
against the universal `DeepResearch.researchStream` accessor, so the body stays
portable across providers.

```ts
import { researchStream } from "@effect-uai/core/DeepResearch"
import * as Items from "@effect-uai/core/Items"
import * as Turn from "@effect-uai/core/Turn"

researchStream({ history: [Items.userText(question)] }).pipe(
  Stream.runForEach((event) =>
    Match.value(event).pipe(
      Match.tag("WebSearchCall", (e) => Console.log(`  · ${e.status}`)), // live progress
      Match.tag("TextDelta", (e) => write(e.text)), // the report, as written
      Match.tag("TurnComplete", (e) => printSources(Turn.citations(e.turn))), // final citations
      Match.orElse(() => Effect.void),
    ),
  ),
)
```

The stream terminates in `TurnComplete`, whose `turn` is a `Turn` (the same value
a normal generation returns): project it with `Turn.assistantText` and
`Turn.citations`. Under the hood the adapter submits a background job
(`o3-deep-research` on OpenAI, `sonar-deep-research` on Perplexity) and streams or
polls it to completion. On providers that stream (OpenAI) the events are real; on
poll-only ones (Perplexity) progress is synthesized, same body. If you only want
the final report, `research(request)` returns the `Turn` directly and drops the
stream.

## Run it

```bash
PERPLEXITY_API_KEY=... pnpm tsx recipes/native-deep-research/run-node.ts
OPENAI_API_KEY=...     pnpm tsx recipes/native-deep-research/run-node.ts --provider=openai

QUESTION="compare the leading open-weight LLMs released this quarter" \
  PERPLEXITY_API_KEY=... pnpm tsx recipes/native-deep-research/run-node.ts
```

The report prints once the job completes, followed by its sources. `run-bun.ts`
and `run-deno.ts` differ only in the platform HttpClient.
