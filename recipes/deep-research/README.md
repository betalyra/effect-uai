---
title: Deep research
description: Turn a broad question into a cited briefing. Plan it into sub-questions, research each one in parallel, and synthesize a report you can watch assemble.
source: recipes/deep-research
icon: PiAtom
---

Some questions are too broad for one search. "Compare the leading X for Y",
"what's the state of Z": answering them well means investigating several
angles and pulling the threads together, not running a single query. That
is what a deep-research agent does, and it is the shape behind the
deep-research modes in ChatGPT, Gemini, Perplexity, and Claude.

The job splits into three steps you can build directly:

```ts
const { subQuestions } = yield * plan(question) // break the question into angles
const findings = yield * fanOut(subQuestions) // research each one, in parallel
return synthesize(question, findings) // write one cited report
```

## Research each angle with a grounded-answer agent

Each sub-question is its own small research task: search the web, read,
answer with sources. You already have an agent that does exactly that, so a
sub-agent is just the [grounded answer](/recipes/grounded-answer/) recipe,
bounded:

```ts
import { groundedAnswer } from "../grounded-answer/recipe.js"

groundedAnswer({ question, model, maxRounds: 2, maxResults: 5 })
```

Running them concurrently is one `Stream.flatMap` with a `concurrency`
setting. Each sub-agent works in its own context and returns a short,
already-cited answer, so the final synthesis reads a handful of tidy
findings rather than a pile of raw search results. that keeps the report
coherent and the context small no matter how broad the question.

## Watch it work

A research run takes a while, so you want to see it happening, not stare at
a spinner. The recipe streams the whole thing as one feed of tagged events:
the plan, then each sub-agent's searches and answer as they come in, then
the report writing itself.

```ts
type DeepResearchEvent =
  | { _tag: "Planned"; subQuestions: ReadonlyArray<string> }
  | { _tag: "Searching"; index: number; question: string }
  | { _tag: "AnswerDelta"; index: number; question: string; text: string }
  | { _tag: "ReportDelta"; text: string }
  | /* ... */
```

The `index` on each event tells you which sub-agent it came from, so you
can show parallel work in lanes, or read it top-to-bottom at
`CONCURRENCY=1`. The synthesized report streams out at the end with inline
citations and a consolidated source list.

## Tuning a run

The knobs that matter, and the cost that comes with them:

- **`SUB_QUESTIONS`** is how many angles you investigate. More angles means
  broader coverage and more searches.
- **`CONCURRENCY`** is how many sub-agents run at once. Raise it for speed;
  keep it within your search provider's rate limit.
- **`MAX_ROUNDS`** (set per sub-agent in the recipe) bounds how hard each
  angle digs before it answers.

A deep-research run fans out real agents, so it costs noticeably more than a
single question. budget for several searches per sub-question and size the
question to the depth you actually need.

## Going further

The recipe is one clean pass. plan, research, synthesize. The natural ways
to take it further once you need them:

- **Re-plan on gaps**: feed the findings back to the planner and run a
  second round on what's still thin.
- **Dedup and rerank sources** across sub-agents before synthesis.
- **Persist** the findings so a long run can resume or be reviewed.

## Run it

```sh
OPENAI_API_KEY=... PERPLEXITY_API_KEY=... \
  pnpm tsx recipes/deep-research/run-node.ts

# Ask your own, broaden it, run the sub-agents in parallel, swap providers:
QUESTION="compare managed Postgres providers in 2026" SUB_QUESTIONS=5 CONCURRENCY=3 \
  pnpm tsx recipes/deep-research/run-node.ts --llm=gemini --search=tavily
```

| Env / flag      | Meaning                           | Default      |
| --------------- | --------------------------------- | ------------ |
| `QUESTION`      | the research question             | (a sample)   |
| `SUB_QUESTIONS` | how many angles to investigate    | `4`          |
| `CONCURRENCY`   | concurrent sub-agents             | `1`          |
| `--llm`         | `openai` \| `gemini`              | `openai`     |
| `--search`      | `perplexity` \| `exa` \| `tavily` | `perplexity` |

## See also

- [Grounded answer](/recipes/grounded-answer/): the sub-agent each angle
  runs, and where the citation prompting lives.
- [Web search](/search/): the `WebSearch` capability underneath.
- [Structured output](/recipes/structured-output/): how the question is
  decomposed into sub-questions.
