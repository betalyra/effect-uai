---
title: Grounded answer
description: Build your own grounded search with effect-uai. Wire a search backend to an LLM, and prompt it so every claim is cited from a live source.
source: recipes/grounded-answer
icon: PiMagnifyingGlass
---

A language model's training data has a cutoff. Ask it what shipped this
week and it either guesses or refuses. Grounding fixes that: you give the
model live search results and it answers from them. The easy part is the
wiring. The part that earns trust, and the part this recipe is really
about, is making sure every claim comes back with a source you can check.

**Scenario.** Ask a current-events question ("what were the most
significant AI model releases this month?"). The model searches the web,
reads the results, and writes an answer where each fact links to where it
came from.

## Wire a backend to a model

You need two things in scope: a search provider Layer and the
[`webSearchTool`](/search/). The tool sits on the generic `WebSearch` tag,
so the model-facing contract never changes when you switch backends.

```ts
import { webSearchTool } from "@effect-uai/core/WebSearchTool"

const tools = [webSearchTool({ maxResults: 5 })]
// hand `tools` to your model turn; provide one search Layer below
```

Switching the LLM or the search backend is a Layer change, nothing in the
agent body moves:

```ts
import { layer as perplexity } from "@effect-uai/perplexity/PerplexitySearch"
import { layer as exa } from "@effect-uai/exa/ExaSearch"
import { layer as tavily } from "@effect-uai/tavily/TavilySearch"
```

The loop itself (stream a turn, run the tool the model asked for, feed
results back, repeat until it answers) is the ordinary agent shape from
[basic usage](/recipes/basic-usage/) and [agentic loop](/recipes/agentic-loop/).
This recipe adds nothing new there; the source is in
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/grounded-answer/recipe.ts)
if you want to read it.

## Make the model cite

Grounding is only as honest as the citations. A confident answer with no
sources is the failure mode you are trying to design out. Industry
practice converges on a handful of prompt rules that move the needle:

- **Answer only from the search results. No prior knowledge.** This is the
  single highest-impact instruction. It turns the model from "recall what
  I know" into "report what these sources say."
- **Tell it to admit when the sources fall short.** "If the results do not
  support an answer, say so." Permitting "I could not confirm this"
  measurably cuts invented facts, because the model has an honest exit.
- **Cite inline, per claim, not in a trailing list.** A citation glued to
  each sentence is checkable; a pile of links at the bottom is not.
- **Pin the citation format with a one-line example.** Show the exact shape
  you want, e.g. `[source](https://example.com)`. Smaller and faster models
  in particular follow a demonstrated format far better than a described
  one.

Put together, a workable system prompt:

```ts
const SYSTEM_PROMPT = [
  "You are a research assistant. Use the web_search tool to find current information.",
  "",
  "- Answer ONLY from the search results. Do not use prior knowledge for facts.",
  "- You may search more than once to fill gaps, then answer.",
  "- Cite every factual claim inline with its source as a markdown link,",
  "  e.g. The model ships in March [source](https://example.com).",
  "- If the results do not support an answer, say so plainly instead of guessing.",
].join("\n")
```

### The model can only cite what it sees

The citation handle lives in the tool's output. `webSearchTool` renders
each result as a numbered `title / url / snippet` block, so the URL is
right there for the model to link. Two things follow from that:

- **Cite by URL, not by number.** A "[1]" is only stable within one tool
  call; across several searches the numbering restarts and "[1]" becomes
  ambiguous. The URL is always unambiguous, which is why the prompt above
  asks for links. If you want footnote-style `[1]` markers, give the tool a
  `render` that assigns stable ids across the whole run and map them back
  yourself:

  ```ts
  webSearchTool({
    render: (results) =>
      results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet ?? ""}`).join("\n\n"),
  })
  ```

- **Give the model something to ground on.** A backend that returns
  snippets (Perplexity, Tavily) lets the model quote and paraphrase real
  text. Exa's pure search returns ranked `url + title + score` but no
  snippet (its text comes from a separate extract step), so grounding leans
  on titles and the model opening links. Pick the backend to match how much
  the model needs to read, not just price.

For a stronger guarantee than prompting, decode the answer into a typed
shape with a source per claim and verify each one against the results. that
is the [structured output](/recipes/structured-output/) pattern applied to
citations, and a natural next step once the prompt-level version works.

## Run it

```sh
# OpenAI + Perplexity (defaults)
OPENAI_API_KEY=... PERPLEXITY_API_KEY=... \
  pnpm tsx recipes/grounded-answer/run-node.ts

# Swap either axis; each backend brings its own key.
GOOGLE_API_KEY=... PERPLEXITY_API_KEY=... \
  pnpm tsx recipes/grounded-answer/run-node.ts --llm=gemini
OPENAI_API_KEY=... EXA_API_KEY=... \
  pnpm tsx recipes/grounded-answer/run-node.ts --search=exa
OPENAI_API_KEY=... TAVILY_API_KEY=... \
  pnpm tsx recipes/grounded-answer/run-node.ts --search=tavily
```

| Flag       | Values                            | Default      |
| ---------- | --------------------------------- | ------------ |
| `--llm`    | `openai` \| `gemini`              | `openai`     |
| `--search` | `perplexity` \| `exa` \| `tavily` | `perplexity` |

Set `QUESTION` to ask your own, and tune `MODEL`, `MAX_ROUNDS`, and
`MAX_RESULTS` the same way. The answer streams to stdout as the model
writes it.

## See also

- [Web search](/search/): the capability. the `WebSearch` tag,
  `webSearchTool`, and the provider backends.
- [Structured output](/recipes/structured-output/): decode the answer into
  typed claims-with-sources you can verify or gate on.
