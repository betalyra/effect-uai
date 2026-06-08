---
title: Grounded answer
description: Answer a current-events question by letting the model drive a web-search tool, then cite its sources inline. Swap the LLM and the search backend independently.
source: recipes/grounded-answer
icon: PiMagnifyingGlass
---

A language model's training data has a cutoff. Ask it what shipped this
week and it either guesses or refuses. Grounding fixes that: give the
model a `web_search` tool, let it search, read the results, and write an
answer backed by live sources.

**Scenario.** Ask a current-events question ("what were the most
significant AI model releases this month?"). The model searches the web
one or more times, then answers with inline citation links.

## The shape

`recipe.ts` is one `Effect` that runs a bounded tool loop:

1. Run a model turn with the `web_search` tool available.
2. If the model called the tool, execute the search, feed the results
   back, and loop.
3. If the model answered instead, stop and return the text.

```ts
const result = yield * turn({ history, model, tools: descriptors })
const calls = Turn.getToolCalls(result)
if (calls.length === 0) return { answer: Turn.assistantText(result), rounds }

const results = yield * Toolkit.collectResults(Toolkit.run(tools, calls))
const next = Toolkit.appendToolResults({ history }, result)(results)
// ...loop with next.history
```

There is no streaming and no queue here. The model either asks to search
or it answers, and a round cap forces a final, tool-free turn so the
agent always terminates with an answer instead of looping forever.

## One tool, any backend

The tool is the shipped `webSearchTool` from `@effect-uai/core`. Its only
requirement is the generic `WebSearch` tag, so the model-facing contract
(name, description, argument schema) is identical no matter which search
provider answers:

```ts
import { webSearchTool } from "@effect-uai/core/WebSearchTool"

const tools = [webSearchTool({ maxResults: 5 })]
```

The model controls only `query` and `recency`. The result cap is an
app-set cost ceiling, fixed on the constructor, not a knob the model can
turn.

## Portability on two axes

This is the recipe that justifies the whole capability. The program body
names no provider. It yields the generic `LanguageModel` and `WebSearch`
tags, so you swap either axis at the Layer with no change to `recipe.ts`
and no change to the tool the model sees:

```sh
# OpenAI + Perplexity (defaults)
OPENAI_API_KEY=... PERPLEXITY_API_KEY=... \
  pnpm tsx recipes/grounded-answer/run-node.ts

# Gemini + Perplexity
GOOGLE_API_KEY=... PERPLEXITY_API_KEY=... \
  pnpm tsx recipes/grounded-answer/run-node.ts --llm=gemini
```

| Flag       | Values                 | Default      |
| ---------- | ---------------------- | ------------ |
| `--llm`    | `openai` \| `gemini`   | `openai`     |
| `--search` | `perplexity` \| `exa`  | `perplexity` |

The `--search` flag is wired to grow: Tavily, You.com, and Brave each
land as one alias entry and one Match arm in `app.ts`, with nothing in
`recipe.ts` touched. Exa needs `EXA_API_KEY`:

```sh
OPENAI_API_KEY=... EXA_API_KEY=... \
  pnpm tsx recipes/grounded-answer/run-node.ts --search=exa
```

One honest difference shows through the portable interface: Exa's pure
`/search` returns ranked url + title + relevance `score` but no text
snippet (snippets come from its separate `contents` extract step, which
is out of scope here), whereas Perplexity returns a snippet and no score.
The model still gets ranked URLs to read either way.

Ask your own question with the `QUESTION` env var, and tune `MODEL`,
`MAX_ROUNDS`, and `MAX_RESULTS` the same way.

## Citations

The system prompt requires the model to cite every factual claim inline
as a markdown link to its source, and to say so plainly when the searches
do not support an answer rather than guessing. The grounding is only as
honest as the answer's links, so forcing inline sources is what turns
"search-flavored prose" into something checkable.

## Files

- `recipe.ts` — the runtime-agnostic tool loop (`LanguageModel | WebSearch`).
- `app.ts` — provider flags, Layers, config, and the `main` effect.
- `run-node.ts` / `run-bun.ts` / `run-deno.ts` — platform HttpClient + runtime.

## See also

- [Basic search](/recipes/basic-search/) — query in, ranked results out,
  no LLM.
- [Agentic loop](/recipes/agentic-loop/) — the streaming tool-loop this
  recipe is a single-shot variation of.
