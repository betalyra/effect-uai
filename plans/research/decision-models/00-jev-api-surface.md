# Jev / System One: the wire and SDK surface

Primary sources only, fetched 2026-09-18 from `docs.typesafe.ai` and from the
official JS SDK's `types.ts` at
`https://raw.githubusercontent.com/typesafe-ai/typesafe-sdk-js/v0.6.0/src/types.ts`.
Companion files: [01-typesafe-jev-reception.md](./01-typesafe-jev-reception.md)
(community reception, agent transcript),
[02-capability-conventions-in-tree.md](./02-capability-conventions-in-tree.md)
(how this repo builds a capability),
[03-embeddings-rerankers-generic-path.md](./03-embeddings-rerankers-generic-path.md)
(whether commodity embedding / reranker APIs can back the same abstraction).

## 1. One endpoint, one call shape

`POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <key>`,
JSON in, JSON out. No streaming, no other endpoints in the docs.

The whole API is: **one `state`, N named `questions`, all evaluated in
parallel against that state, N answers keyed by question name.**

```ts
interface SystemOneRequest<Q extends Questions = Questions> {
  state: EntryType // text, JSON object, JSON array, or null
  questions: Q // nonempty, keyed by the answer key
  model?: string // defaults to jev-latest via client config
}

type EntryType = string | { [key: string]: JsonValue } | JsonValue[] | null
```

Response:

```ts
interface SystemOneResult<Q extends Questions> {
  readonly model: string
  readonly answers: { readonly [K in keyof Q]: ResultFor<Q[K]> }
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number }
}
```

## 2. The three question types

Verbatim from the SDK types:

```ts
interface NoulQuestion {
  type: "noul"
  instructions?: EntryType
  criteria?: { true?: EntryType; false?: EntryType } | null
}

interface ChoiceQuestion<T extends ChoiceCriteria = ChoiceCriteria> {
  type: "choice"
  instructions?: EntryType
  criteria: T // { [label: string]: Description }
}

type ScoreCriteria = readonly [EntryType, EntryType, ...EntryType[]]
interface ScoreQuestion<T extends ScoreCriteria = ScoreCriteria> {
  type: "score"
  instructions?: EntryType
  criteria: T // ordered rubric, index 0 upward
}
```

Answers:

```ts
interface NoulResponse {
  type: "noul"
  noul: number
} // P(yes), 0..1
interface ChoiceResponse<T> {
  type: "choice"
  choice: keyof T & string
  confidence: number
  probabilities: Record<keyof T, number>
}
interface ScoreResponse<T> {
  type: "score"
  score: number
  confidence: number
  legend: ScoreLegend<T>
  probabilities: Record<ScoreOf<T>, number>
}
```

Load-bearing details:

- **`noul` has no `confidence` field.** It is a bare probability. Choice and
  Score both carry `confidence`.
- **`score` is a probability-weighted mean** of the level indices, so it is
  continuous and can land between levels: the docs' worked example is
  `(0 x 0.0) + (1 x 0.7) + (2 x 0.3) = 1.3`. `legend` maps the integer level
  back to its description.
- **`confidence` is undocumented as a formula.** The docs say only that it
  "collapses that shape into a single number from 0 to 1" and that a cookbook
  on "pros and cons of different computations" is planned. It is derivable
  from `probabilities`, which the answer already carries.
- **`instructions` is optional on all three types**, and every text slot
  (`instructions`, each criterion, `criteria.true` / `.false`) accepts nested
  JSON, not just a string.
- **Choice takes up to 255 options**, and adding options "costs only a few
  tokens per option".
- **Score takes 2 to 10 levels** per the docs; the type only enforces 2+.
- **Answers are independent.** "Removing questions doesn't affect remaining
  answers." Also: no structural invariants across questions, so
  `P(yes) != 1 - P(not yes)`.

## 3. Model, limits, pricing

- `jev-1.13.0`; aliases `jev-latest` (SDK default) and `jev-preview`
  (currently identical).
- 64k tokens per request total, of which ~32k for `state` plus the longest
  single question. Roughly 150k characters.
- Text only. No image, audio or video.
- 250,000 tokens/sec and 1,200 req/min, described as adjusting dynamically.
- $42 per billion input tokens ($0.042 / MTok). Output tokens free.
- Not fine-tuned per customer; shared weights. English best, other languages
  including CJK supported at lower reliability.
- Also resold: OpenRouter (`typesafe/jev-1.13`, `~typesafe/jev-latest`, 32K
  context) and Cloudflare Workers AI (`typesafe/jev`).

## 4. Documented failure modes (`model-jaggedness/jev-1.13`)

Nine, and several of them bear directly on how a capability should be typed:

1. Literal reading: misses scoping, negation, implied conditions.
2. Math and counting: unreliable.
3. Date/time comparison: cannot reliably order dates or compute durations.
4. Indirection: double negatives and multi-hop degrade accuracy.
5. Large irrelevant state acts as a distractor.
6. Adversarial content: state is not treated as hostile. Injected
   instructions can steer the output.
7. Contradictory `instructions` vs `criteria` confuse it.
8. **No structural invariants.** Negated questions do not sum to 1.0, and
   metrics are not comparable across primitives.
9. Generation: cannot generate text. Extraction must go through bounded
   Choice options.

Plus: "Score outputs have weak numerical calibration and shouldn't be
interpolated for exact magnitude reconstruction." That is the vendor's own
caveat on the one number people will most want to threshold.

## 5. The batching economics, which drive the API shape

From `cookbooks/parallel_questions`: 13 questions batched into one call cost
$0.000497 at 0.27s; the same 13 asked one at a time cost $0.006090 at 2.71s.
**12.2x cheaper, 10.0x faster.** The reason is that `state` is billed once
per call and dominates every request.

`patterns/fan-out` makes this explicit: "All questions are evaluated in
parallel, so adding more questions to a call typically doesn't add any
latency to the response," and therefore you should send speculative questions
you may not need and discard the irrelevant answers in code.

**Design consequence: the natural unit of work is a batch of heterogeneous
questions against one shared state, not a single question.** Any abstraction
that exposes only `classify(one thing)` throws away an order of magnitude.

## 6. What the docs build out of the three primitives

Worth reading as the de-facto list of derived operations, because it tells us
which of these belong in a core capability and which belong in a recipe:

| Doc                                         | Derived operation                           | Built from                                                                                                                                                                                                            |
| ------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cookbooks/rerank_typesafe`                 | Reranking a BM25 shortlist                  | one Noul per (query, candidate) pair, 1,200 calls for 40 queries x 30 candidates. Reported top-1 5% to 18%, top-10 38% to 62%, $0.0645 total                                                                          |
| `cookbooks/semantic_find`                   | Line-by-line search over a document         | one Choice over up to 255 line ids, plus one Noul for "does the document answer at all"                                                                                                                               |
| `cookbooks/hierarchical_classification`     | Taxonomy classification                     | one Choice per tree level, sequential; greedy or beam search over paths                                                                                                                                               |
| `cookbooks/classification_using_confidence` | Abstention / back off to a coarser label    | one Choice over 75 groups, then use `confidence >= 0.9` to decide whether to report the group or its parent division. 90% accurate above the threshold, 40% below, 80% "useful answers" overall across 60 SEC filings |
| `cookbooks/entity_alignment`                | Record dedup / entity matching              | one Score (3 levels) plus three Nouls per candidate pair. No embeddings, no clustering, no threshold fitting: the nearest level names the outcome                                                                     |
| `cookbooks/classifying_rag_passages`        | Post-retrieval filtering                    | four Nouls per passage: relevance, answer evidence, premise contradiction, prompt injection                                                                                                                           |
| `cookbooks/function_calling`                | Tool selection plus argument extraction     | one Choice over functions, one Noul per optional argument for "was it mentioned at all", Choice per enum argument. Confidence reported as the min across arguments                                                    |
| `cookbooks/sde_cascade`                     | Verify a cheap model's extraction, escalate | Nouls per field on failure modes (hallucination, type mismatch, format, missing), any-flag gate at 0.7                                                                                                                |
| `patterns/composite-scoring`                | Weighted multi-dimension score              | N Scores, each normalized by dividing by its max level, then a weighted sum in code                                                                                                                                   |
| `patterns/confidence-routing`               | Risk-tiered automation                      | a universal confidence floor plus per-action thresholds                                                                                                                                                               |
| `cookbooks/consistency_noul_cookbook`       | Self-consistency                            | 15 repeats with a varying `uid` to defeat caching. Reported mean probability stddev 0.0102                                                                                                                            |

Note what this list implies: **clustering is absent**, reranking is a fan-out
of pointwise Nouls (not a listwise call), and every "higher-level" operation
is composition in the caller's code, not an API feature.

## 7. Client config surface (for provider `Config` design)

`TypeSafeClientConfig`: `apiKey` (falls back to `TYPESAFE_API_KEY`),
`baseURL` (`TYPESAFE_BASE_URL`, default `https://api.typesafe.ai`),
`defaultModel` (`TYPESAFE_DEFAULT_MODEL`, default `jev-latest`), plus
logging, retry policy, per-attempt timeout (default 10000ms),
`defaultHeaders`, `dangerouslyAllowBrowser`, custom `fetch`.

Errors: 401 invalid/missing key, 422 validation, 429 rate limit, 529
overloaded. SDK retries 408, 429 and 500-599 with exponential backoff and
honors `Retry-After` / `retry-after-ms`.

npm package is `@typesafe-ai/sdk`.

## 8. Doc inconsistency to watch

`primitives/score.md` shows a request body with `"selectedModels": ["jev-latest"]`,
but both `api.md` and the SDK's `SystemOneRequestPayload` have a single
`model: string` and no `selectedModels`. Treat the SDK types as authoritative
and re-check against a live response before implementing.
