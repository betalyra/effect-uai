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

`recipe.ts` is an explicit streaming `Loop` (the same machinery as
[basic-usage](../basic-usage/) and [agentic-loop](../agentic-loop/)). Each
iteration streams a model turn; `onTurnComplete` inspects it:

```ts
streamTurn({ history: state.history, model, tools: descriptors }).pipe(
  onTurnComplete((turn) =>
    Effect.sync(() => {
      const calls = Turn.getToolCalls(turn)
      if (calls.length === 0) return stop() // model answered; end the loop
      return Toolkit.run(tools, calls).pipe(
        Toolkit.continueWithResults(
          Toolkit.appendToolResults({ ...state, round: state.round + 1 }, turn),
        ),
      )
    }),
  ),
)
```

The answer streams token-by-token as the model writes it. the recipe
yields a `Stream` of turn / tool events and the runner forwards the
`TextDelta`s to stdout live. A round cap withholds the tools on the final
turn, forcing an answer so the agent always terminates instead of looping.

One subtlety the types catch: the body returns the `streamTurn` `Stream`
directly rather than wrapping it in `Effect.gen`. Yielding the
`LanguageModel` tag inside a gen would split the requirement (`LanguageModel`
on the effect, `WebSearch` on the tool stream) and they would not unify;
the free `streamTurn` helper keeps `R` as one `LanguageModel | WebSearch`.

### Tracing

`webSearchTool` wraps each call in an `Effect.withSpan`, so when a `Tracer`
is installed the trace shows `web_search(query=…) -> N results` nested
under the model turn. It is a no-op (free) until you install one.

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

| Flag       | Values                            | Default      |
| ---------- | --------------------------------- | ------------ |
| `--llm`    | `openai` \| `gemini`              | `openai`     |
| `--search` | `perplexity` \| `exa` \| `tavily` | `perplexity` |

The `--search` flag is wired to grow: You.com and Brave each land as one
alias entry and one Match arm in `app.ts`, with nothing in `recipe.ts`
touched. Each backend needs its own key (`EXA_API_KEY`, `TAVILY_API_KEY`):

```sh
OPENAI_API_KEY=... EXA_API_KEY=... \
  pnpm tsx recipes/grounded-answer/run-node.ts --search=exa

OPENAI_API_KEY=... TAVILY_API_KEY=... \
  pnpm tsx recipes/grounded-answer/run-node.ts --search=tavily
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

- `recipe.ts`: the runtime-agnostic tool loop (`LanguageModel | WebSearch`).
- `app.ts`: provider flags, Layers, config, and the `main` effect.
- `run-node.ts` / `run-bun.ts` / `run-deno.ts`: platform HttpClient + runtime.

## See also

- [Basic search](/recipes/basic-search/): query in, ranked results out,
  no LLM.
- [Agentic loop](/recipes/agentic-loop/): the streaming tool-loop this
  recipe is a single-shot variation of.
