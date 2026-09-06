# Recipes

Working examples of common agent patterns, each composed from the same
`@effect-uai` primitives: state, streams, turns, tools, and explicit
continuation.

Recipes are not published packages. They are type-checked, runnable examples
that double as living regression tests for the primitive surface.

## The shape

Every recipe is the same four files:

| File        | What it holds                                                |
| ----------- | ------------------------------------------------------------ |
| `recipe.ts` | The effect-uai logic. Names capability tags, never a vendor. |
| `app.ts`    | Composition: flags, provider Layers, rendering, and `main`.  |
| `run.ts`    | One line. Same file on Node, Bun and Deno.                   |
| `README.md` | The scenario.                                                |

Plus `recipe.test.ts` where a recipe has stream or loop logic worth pinning
down.

Running one is the same everywhere:

```sh
pnpm tsx recipes/<name>/run.ts
bun recipes/<name>/run.ts
deno run --allow-all recipes/<name>/run.ts
```

The shared plumbing lives in [`@effect-uai/recipe-kit`](../packages/recipe-kit):
`runRecipe` / `serveRecipe` pick each runtime's platform layers, `argv` parses
flags, `output` hands out `output/<recipe>/<timestamp>/` for whatever a run
produces. Provider selection is separate, in
[`_shared/model.ts`](./_shared/model.ts): one place that knows which package,
base URL and env var each provider needs, so `--model provider:model` works
across every capability.

## Language models

- [`basic-usage/`](./basic-usage/) - the core harness: state, stream, tools,
  and continuation.
- [`structured-output/`](./structured-output/) - one schema as provider
  contract and local validator.
- [`streaming-structured-output/`](./streaming-structured-output/) - decode
  prompted JSONL one object at a time.
- [`tool-call-approval/`](./tool-call-approval/) - gate sensitive calls before
  `run`; still return one result per model-requested tool call.
- [`streaming-tool-output/`](./streaming-tool-output/) - show inner tool work
  to the user while returning one clean output to the model.
- [`mcp-tools/`](./mcp-tools/) - turn a live MCP server's tools into a
  `Toolkit`; connection lifetime is stream lifetime.
- [`agentic-loop/`](./agentic-loop/) - drive a long-lived chat from a user
  message queue while continuing work between clean turn boundaries.
- [`auto-compaction/`](./auto-compaction/) - summarize history when the token
  or turn budget is exceeded.
- [`pause-resume/`](./pause-resume/) - pause between loop iterations with a
  latch; no provider call remains open.
- [`mid-stream-abort/`](./mid-stream-abort/) - cancel the loop and the
  upstream HTTP request via scope-based cleanup.
- [`sleeper-agent/`](./sleeper-agent/) - pause for an external task; a forked
  polling fiber resolves a `Deferred` the loop awaits.
- [`modify-output-stream/`](./modify-output-stream/) - keep the loop
  transport-agnostic; project typed turn events into SSE or JSONL at the edge.
- [`basic-metrics/`](./basic-metrics/) - time-to-first-token, throughput and
  token totals as plain stream operators.

## Choosing a model

- [`model-retry/`](./model-retry/) - retry policy around one model stream;
  only transient provider failures get another try.
- [`model-escalation/`](./model-escalation/) - start cheap; let the model
  escalate hard questions to a stronger tier via a tool call.
- [`multi-model-fallback/`](./multi-model-fallback/) - recover from provider
  stream failures by advancing to the next tier.
- [`multi-model-compare/`](./multi-model-compare/) - fan one prompt out to
  multiple providers and isolate per-member failures.
- [`model-council/`](./model-council/) - stream candidate answers, judge them
  cross-model, and emit a winner.

## Retrieval and the web

- [`basic-embedding/`](./basic-embedding/) - embed a query and a corpus, rank
  by cosine.
- [`multimodal-embedding/`](./multimodal-embedding/) - one space for images
  and text; rank a mixed corpus against a picture.
- [`multivector-embedding/`](./multivector-embedding/) - one vector per token,
  scored with `maxSim`.
- [`retrieve-and-rerank/`](./retrieve-and-rerank/) - your top results are about
  the question but don't answer it; add a rerank pass and see which documents
  move.
- [`grounded-answer/`](./grounded-answer/) - wire a search backend to a model
  so every claim is cited from a live source.
- [`native-grounding/`](./native-grounding/) - the same, using the provider's
  own hosted web search.
- [`deep-research/`](./deep-research/) - plan a question into sub-questions,
  research them in parallel, synthesize a cited report.
- [`native-deep-research/`](./native-deep-research/) - hand the whole research
  job to a provider that runs it server-side.
- [`market-intel/`](./market-intel/) - read vendor pricing pages to markdown
  and extract typed records from them.

## Images

- [`storyboard/`](./storyboard/) - a language model steers the plot, an image
  model draws every panel, and the cast stays itself across all of them.
- [`conversational-image-edit/`](./conversational-image-edit/) - edit one
  picture across a conversation without the subject drifting.

## Speech and music

- [`basic-speech-synthesis/`](./basic-speech-synthesis/) - text in, audio out;
  one-shot or chunked.
- [`advanced-speech-synthesis/`](./advanced-speech-synthesis/) - multi-speaker
  dialogue with per-voice pronunciation hints.
- [`streaming-synthesis/`](./streaming-synthesis/) - audio starts on the first
  chunk, not the last.
- [`basic-transcription/`](./basic-transcription/) - an audio file in, text
  back, same call across providers.
- [`streaming-transcription/`](./streaming-transcription/) - live captions
  while the user is still speaking.
- [`voice-loop/`](./voice-loop/) - streaming STT to model to streaming TTS,
  with stop-word interrupt.
- [`basic-music-generation/`](./basic-music-generation/) - a short prompt is
  enough; two providers behind one tag.
- [`radio-station/`](./radio-station/) - a DJ writes the next track while the
  current one plays; the set replays from cache after the first pass.

## Browsers

- [`browser-usability/`](./browser-usability/) - describe a goal, point it at
  your site, get a typed report of whether an agent could do it.
- [`dashboard-briefing/`](./dashboard-briefing/) - when the chart renders
  client-side, the dashboard is the only API you have.

## Recipes that install separately

A few recipes carry heavy or unusual dependencies, so they live in
[`recipes-extras/`](../recipes-extras) with their own lockfile and are
installed from inside their own folder. They follow the same shape.

- [`agentic-search/`](../recipes-extras/agentic-search/) - hybrid retrieval
  over a libsql store, exposed to the agent as one tool.
- [`contextual-retrieval/`](../recipes-extras/contextual-retrieval/) - the
  same pipeline with contextualized chunks, so the two can be compared.
- [`sandbox-code-interpreter/`](../recipes-extras/sandbox-code-interpreter/) -
  the model writes code and it runs in a microVM, not in your process.
