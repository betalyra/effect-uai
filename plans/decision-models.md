# Decision models. capability design note

Status: agreed in outline, not started. Part 1 is the design and the evidence
behind it; Part 2 is the step order. Work proceeds strictly in Part 2's order.

Scope: whether `effect-uai` should define a capability for the class of models
TypeSafe AI opened with Jev (structured, calibrated decisions instead of
generated text), what its shape should be, and whether it can be backed by
anything other than a single vendor.

Research this note rests on, all in
[research/decision-models/](./research/decision-models/), and this file wins on
any conflict with them:

- [00-jev-api-surface.md](./research/decision-models/00-jev-api-surface.md).
  The wire and SDK surface, read from `docs.typesafe.ai` and the official JS
  SDK's `types.ts`. Limits, documented failure modes, batching economics, and
  the table of operations the cookbooks derive from the three primitives.
- [01-typesafe-jev-reception.md](./research/decision-models/01-typesafe-jev-reception.md).
  Launch facts, independent benchmarks, the skeptical consensus. Agent
  transcript, kept verbatim with its own hedges.
- [02-capability-conventions-in-tree.md](./research/decision-models/02-capability-conventions-in-tree.md).
  How this repo builds a capability, with file:line citations.
- [03-embeddings-rerankers-generic-path.md](./research/decision-models/03-embeddings-rerankers-generic-path.md).
  Whether commodity embedding and reranker APIs can back the same abstraction.
  Verbatim parameter surfaces for eleven reranker APIs and every embedding
  task-type enum.

Companions in tree: [capabilities.md](./capabilities.md) (the three-bucket
policy this design obeys), [research/reranking-plan.md](./research/reranking-plan.md#L70)
(the precedent for asking "is this worth a capability?" before building),
[embedding-revamp.md](./embedding-revamp.md) (the sibling that most resembles
the provider-narrowing pattern used here).

---

## 1. What the thing actually is

Jev is one endpoint. `POST /v1/systemone` takes one `state` plus N named
`questions`, evaluates every question against that state in parallel, and
returns N answers keyed by question name. Three question kinds:

| Kind     | Asks                                               | Answer                                                                       |
| -------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `choice` | which of these labels, up to 255                   | the label, a probability per label, a confidence                             |
| `score`  | which level of this ordered rubric, 2 to 10 levels | a probability-weighted mean, a probability per level, a legend, a confidence |
| `noul`   | is this statement true                             | a bare probability of yes, with no confidence field                          |

No generation, no streaming, no tools, no images. 64k tokens per request, 32k
of it for `state`. $0.042 per million input tokens, output free.

Three properties of that API matter more than the primitives themselves.

**The unit of work is the batch, not the question.** 13 questions in one call
cost $0.000497 at 0.27s; the same 13 one at a time cost $0.006090 at 2.71s.
That is 12.2x cheaper and 10.0x faster, because `state` is billed once per
call and dominates every request. The vendor's own `patterns/fan-out` tells
you to send speculative questions you may not need and discard the irrelevant
answers in code. **Any abstraction shaped as `classify(oneThing)` throws an
order of magnitude away.**

**Every higher-level operation is composition in the caller's code.** The
cookbooks build reranking (one boolean per query/candidate pair), taxonomy
classification (one choice per tree level, greedy or beam), entity matching
(one score plus three booleans per pair), tool selection (one choice over
functions plus one boolean per optional argument), extraction verification
(booleans per field, any-flag gate at 0.7), and composite scoring (N scores,
normalized by max level, weighted sum). None of those are API features. This
is exactly the library's own thesis about explicit loops, which is a point in
the capability's favour: the primitives are small and the composition is ours.

**The vendor documents its own jaggedness, and some of it is load-bearing.**
No structural invariants, so `P(yes) != 1 - P(not yes)`. Score calibration is
weak and "shouldn't be interpolated for exact magnitude reconstruction".
State is not treated as hostile, so prompt injection in `state` steers the
answer. Math, counting and date comparison are unreliable. An independent
probe also found option **position** changes accuracy and that adding
irrelevant options shifts the probability ratio between the existing ones.

## 2. Does it deserve a capability?

### 2.1 The case against, stated first

The first two bullets are the argument I initially found persuasive and §2.4
refutes. They are kept because they are the objections anyone will raise.

- **N=1 provider.** `plans/realtime.md` sets the house principle "Two
  providers or none." The category is three days old. **Refuted in §2.4:** the
  principle is about provider packages for a wire protocol, and `Chunker` and
  `Tokenizer` are both core tags with no provider at all.
- **Nothing is cross-provider yet, so unifying is guessing.** House rule:
  don't unify what isn't unified. **Refuted in §2.4:** the question kinds
  predate TypeSafe by years, and the shape was checked against two other
  backings before committing.
- **The independent benchmarks do not show a new capability frontier.** On
  reranking, Jev lands at parity with Cohere Rerank 4 Pro (nDCG@10 0.692 vs
  0.691, the author's own 95% interval spanning zero) and the most careful
  study, which measures judge circularity, finds it **-0.028 nDCG@10 as a
  standalone reranker under labels it did not produce**. On tool-call
  prediction one integrator found plain keyword counting beat it 26% to 15%.
  Three of eight candidate integrations in that writeup were abandoned.
- **The name is a hazard.** A package called `typesafe` inside an
  Effect/TypeScript library reads as "type-safe helpers", and there is an
  unresolved question about Lightbend's `Typesafe` trademark in software.

### 2.2 The case for, which I find stronger

- **The shape is genuinely absent from the library and genuinely needed.**
  The repo has exactly one scoring capability (`Reranker`) whose predicate is
  hard-wired to relevance, and exactly one judgment implementation
  (`recipes/model-council`), which is an LLM prompted to reply with
  `{"score": number 0-10, "rationale": string}`, parsed by `Schema`, with no
  service tag and no probability at all. `internal-docs/roadmap-from-assessments.md:124`
  already names "classifiers, summarizers, judge calls" as a gap with no
  design. Every agent loop in this library has decision points (continue or
  stop, escalate or answer, approve or ask, keep or drop this candidate) and
  today the only tool for them is a full language-model turn.
- **There is a credible second implementation, and it is what makes the
  capability worth having.** A `DecisionModel` can be backed by any
  `LanguageModel` with a constrained answer set plus renormalized token
  logprobs. That is the same forward pass a reranker already runs (see 2.3),
  it is documented in the literature, and it means the payoff is portability:
  **the same typed decision program runs on a decision model for speed and
  cost, or on a frontier LLM when the judgment is hard.** That is the
  library's established value proposition for `LanguageModel` and
  `EmbeddingModel`, applied here.
- **The one place a careful independent test finds a clear win is
  composition, and we already have the composition primitive.** Fused with
  an embedding ranking via reciprocal rank fusion, the same study that found
  -0.028 standalone finds `rrf(bge-m3, jev@30)` at **+0.090 nDCG@10**
  (CI +0.077 to +0.104), holding at **+0.064** under independent judging.
  Its conclusion: "Jev is worth adding only on top of semantic candidates,
  and only fused." Weight it for what it is: one study, one author, 164
  queries over (query, skill) pairs. What makes it worth building on is not
  the magnitude but that it is the only one that controlled for judge
  circularity, and the standalone story is the one that collapsed.
  **Of the three stages that configuration needs, we already have two:**
  `EmbeddingModel` for the candidates and `Rank.rrf` at
  [packages/retrieval/src/Rank.ts:23](../packages/retrieval/src/Rank.ts#L23)
  for the fusion. The missing stage is exactly "score a candidate against an
  arbitrary question and return a probability", which is this capability.
- **The confidence-gated third branch is the affordance nothing else has.**
  No embedding or reranker API has a "none of these" output. The vendor's own
  numbers on abstention are the most convincing in the docs: on 60 SEC
  filings, a single choice over 75 industry groups is 90% accurate above
  confidence 0.9 and 40% below it, and backing off to the parent division
  below the threshold turns that 40% into 70%, for 80% useful answers
  overall. That pattern (act, confirm, or escalate) is what the repo's
  `Approval` machinery at
  [packages/core/src/tool/Approval.ts:50](../packages/core/src/tool/Approval.ts#L50)
  exists to express.

### 2.3 The structural finding that decides the design

From [03](./research/decision-models/03-embeddings-rerankers-generic-path.md) §3.3,
verified against model cards: **a modern instruction-following reranker is a
constrained-token yes/no judge wearing a different name.** Qwen3-Reranker's
system prompt is literally "Judge whether the Document meets the requirements
based on the Query and the Instruct provided. Note that the answer can only be
"yes" or "no"", and its score is `log_softmax` over the `yes`/`no` token
logits, exponentiated. Contextual AI reads one vocabulary logit at the final
position. mxbai-rerank-v2 was RL-trained to "output 1 for relevant documents
and 0 for irrelevant ones". monoT5 established the pattern in 2020.

So "rerank" and "boolean judgment with a probability" are the same
computation. The hosted reranker APIs differ only in that they (a) pin the
question to relevance, (b) normalize the score in an undocumented,
query-dependent way, and (c) discard everything but the ordering.

**A decision model's first contribution is therefore not a new kind of
intelligence. It is letting you state the question.** That is a real and
durable gap, and it is the thing to build the abstraction around.

### 2.4 Verdict: a core tag, from the start

**Yes, and the core tag lands in the first step**, not after a second vendor
appears. An earlier draft of this note staged it provider-first on a "two
providers or none" argument. That argument was wrong here, for four reasons
worth recording so nobody re-derives it.

**The repo already ships core tags with no provider at all.** `Chunker` and
`Tokenizer` are both declared in `packages/core` and implemented only in
`@effect-uai/retrieval`
([Chunking.ts:277](../packages/retrieval/src/Chunking.ts#L277),
[HuggingFaceTokenizer.ts](../packages/retrieval/src/HuggingFaceTokenizer.ts)).
Zero provider packages reference either. So "a core tag needs two vendors" is
not a house rule; `plans/realtime.md`'s "Two providers or none" is about
shipping provider packages for a wire protocol, which is a different
question.

**The relevant count is implementations of the interface, not vendors selling
a product.** That count is at least three: Jev (all three kinds, native
batch), a `LanguageModel` with a constrained answer set (all three kinds,
§6), and an NLI model (`Claim` and `Choice` honestly, `Score` rejected,
§5.5). Only the first is a vendor and only the first can disappear.

**The question kinds are not a TypeSafe invention.** Cohere sold a
supervised `/classify` endpoint in 2022. NLI models have returned entailment
probabilities for years. Qwen3-Reranker's relevance score _is_ a softmax over
`{no, yes}` (§2.3). The one arguably novel thing is the shared-state batch,
and that is a strict generalization rather than a lock-in: a single question
is the N=1 case any backing serves by looping, so shaping the request as a
batch only preserves the 12x where a backing has it (§1).

**Provider-only would cost us every recipe.** `recipes/README.md:11` requires
that `recipe.ts` "Names capability tags, never a vendor." Without a core tag
every recipe names `Jev` and gets rewritten the day the second Layer lands.

The shape was checked against the other two backings on paper before
committing, because the real hazard of going core-first is designing one
vendor's wire and calling it generic (§7.2 flags how mechanical the Jev
mapping is). It survives: `state` maps to an NLI premise and to a prompt
block, a Choice label maps to an NLI hypothesis via template, `model` exists
in all three, and nothing a non-Jev backing needs is absent. One Jev-ism
found: `StateValue` admits JSON objects and arrays, which an NLI premise
cannot take, so that adapter stringifies or rejects.

What is still staged, and what is not:

- **Step 1.** Settle §9.1 first. If the derived answer map does not typecheck
  cleanly, the fallback API is materially worse and the tag's shape changes.
  This is the one thing that must precede a public tag.
- **Step 2.** Core `DecisionModel` (§4), `assertKinds` (§5.1), the
  distribution helpers (§4.2), a `MockDecisionModel`, type-level tests, plus
  the provider package (§7) registering both tags. Docs page.
- **Step 3.** The `LanguageModel`-backed Layer (§6). This is what makes the
  tag a capability rather than a wrapper.
- **Not staged, deferred indefinitely.** Phantom markers (§6, following the
  `Reranker` precedent at `capabilities.md:519`), any further question kinds
  (§5.2), clustering (§5.3), and both reranker bridges (§5.5).

None of this softens the caveats. The category is days old, the vendor has
published no calibration evidence, and the only independent calibration
number is one person's ECE 0.0313 on 1,200 MMLU items. It argues for writing
the score contract in §4.3 honestly and measuring §9.3 ourselves, not for
withholding the tag.

## 3. Can it be backed generically? The honest per-operation answer

This is the question that most needed research, and the answer is mostly no,
in a way that is useful to know precisely. Full detail and verbatim vendor
quotes in [03](./research/decision-models/03-embeddings-rerankers-generic-path.md).

| Operation                                  | Embeddings             | Rerankers                      | LLM + logprobs | Verdict                                     |
| ------------------------------------------ | ---------------------- | ------------------------------ | -------------- | ------------------------------------------- |
| Boolean judgment on an arbitrary predicate | no                     | no                             | yes            | **only the LLM path**                       |
| Classification over labels                 | partial, degrades hard | via relevance only             | yes            | **LLM path; embeddings for coarse cases**   |
| Graded score against a rubric              | no                     | Azure only, otherwise ordering | yes            | **LLM path, or Azure inside its own index** |
| Choose one of N candidates by relevance    | argmax cosine          | yes, `top_n: 1`                | yes            | **all three**                               |
| Clustering                                 | yes                    | no                             | no             | **embeddings, and it is not a service**     |

The four findings that kill the "just use embeddings and rerankers" idea:

**The `CLASSIFICATION` task type does not classify.** Google's own wording
for `CLASSIFICATION` is "Use this task type for training a small
classification model with the embedding"; Cohere's `input_type: classification`
is "Used for embeddings passed through a text classifier". These produce
better features for a classifier you train. They do not return a decision.
We already expose both, at
[GeminiEmbedding.ts:88](../packages/providers/google/src/GeminiEmbedding.ts#L88)
and [JinaEmbedding.ts:37](../packages/providers/jina/src/JinaEmbedding.ts#L37),
and the core doc comment at
[EmbeddingModel.ts:45](../packages/core/src/embedding-model/EmbeddingModel.ts#L45)
already correctly keeps them on the provider request. Nothing changes there.

**`FACT_VERIFICATION` is a retrieval task type, not a claim evaluator.**
Google's own example is that "apples grow underground" should _retrieve_ an
article that would disprove it. It never evaluates the claim. The name is
misleading and we should not build on it.

**Zero-shot classification from embeddings degrades sharply with class
count.** OpenAI's own cookbook gets 0.95 on binary sentiment. Across 22
datasets the best embedding model averages 0.62 macro F1, and the pattern is
sentiment ~0.85, intent 0.59, emotion 0.37. DeBERTa NLI zero-shot is 0.95 on
Amazon Polarity and **0.513 on Banking77**. Scaling the embedding model does
not help (Qwen3-Embedding 0.6B to 8B moves 0.58 to 0.59). The cheap fix is
8 to 64 labels per class with SetFit, which is a training step, not an API
call. Also note the MTEB Classification score is a logistic-regression probe
on 8 samples per label, so a 90.4 there says nothing about argmax-cosine
accuracy; the two rankings correlate at only tau 0.69.

**Reranker scores are not calibrated, and Cohere is the only vendor honest
about it.** Verbatim: "The score is query dependent, and could be higher or
lower depending on the query and passages sent in", and you "can't assume that
a document with a relevance score of 0.9109375 is twice as relevant" as one at
0.044. Their documented path to a threshold costs 30 to 50 representative
queries with hand-labelled borderline documents. Voyage and Jina document no
range or semantics at all. Pinecone documents that scores are not comparable
across model versions. NVIDIA returns a raw logit and tells you to apply
sigmoid yourself. Only ZeroEntropy claims calibration, in a blog post, with
an image for evidence and no metric, and the claim does not appear in its API
reference. Ranking losses are translation-invariant by construction, so this
is not an oversight; it is what the objective produces.

**One exception, and it is instructive: Azure AI Search does return a graded
rubric score.** `@search.rerankerScore` runs 4.0 to 0.0 with a documented
per-level meaning ("highly relevant and answers the question completely" down
to "irrelevant"), which is essentially UMBRELA's 0-3 scale shipped as a
product. Constraints: only the top 50 candidates reach it, each summary is
capped at 2,048 tokens, and it is bound to Azure's own index rather than
being a standalone endpoint. And Microsoft gives the same warning Cohere
does: the distribution "can exhibit slight variations due to conditions at
the infrastructure level", so "don't make the limits too granular". **The
lesson for §4.3 is that even the one vendor who ships a graded, rubric-
anchored scale declines to promise it is finely thresholdable.**

Three secondary findings worth encoding in the design:

- **"Listwise" means two different things, and the distinction is the single
  most useful forward-looking point in the research.** _Listwise decoding_
  has the model emit an ordering: expensive, order-sensitive, non-
  deterministic even at temperature 0, prone to malformed output, and it
  produces **no score at all**, so you cannot threshold or fuse it.
  _Listwise conditioning_ shares one context window across candidates so
  cross-document attention happens, but still emits per-candidate scores.
  The literature is a monotone march from the first to the second (RankGPT
  generates a permutation, FIRST generates one token, jina-reranker-v3
  generates nothing and reads last-token embeddings, E2Rank reduces it to a
  cosine against a listwise-prompt-augmented query embedding at 0.45s/query
  vs 1.97s). Conditioning keeps the quality argument and discards the
  drawbacks, which is why it is the only form that shipped commercially.
  **Any `Ranking` kind we ever add must be conditioning-shaped: scores out,
  not a permutation.**
- **Only one commercial reranker family is listwise, in the conditioning
  sense.** jina-reranker-v3 and v3.5 put the query and up to 64 candidates in
  one 131K context window and score them in a single forward pass
  (arXiv:2509.25085 and arXiv:2607.18152, BEIR 61.94 and 63.20). Everything
  else I checked is pointwise: Cohere v3.5 and v4.0, Voyage rerank-1 through
  3, Mixedbread v2, ZeroEntropy, Contextual AI, NVIDIA, Vertex, Bedrock,
  Pinecone hosted. **No commercial API exposes setwise or pairwise selection
  at all**, and no commercial API returns a permutation. So "choose one of N
  with joint consideration of the set" is a real gap that a decision model's
  `Choice` fills, since Jev sees all 255 options in one pass. Note the v3.5
  weights are CC-BY-NC-4.0, commercial use by arrangement.
- **Order sensitivity is severe, and it applies to `Choice` too.** Google
  Research measured that "ranking metrics can drop by more than 50% when the
  input document order changes": RankGPT on gpt-3.5-turbo goes from 65.80
  nDCG@10 in BM25 order to 32.77 reversed and 25.17 random, a 33-point
  collapse from reordering the same inputs. The independent Jev probe found
  the same shape on a much smaller sample (12/16 correct when the target
  option is first, 16/16 when last). Buying order invariance costs 20x tokens
  via permutation self-consistency (for a 0.4% to 5% relative gain, at about
  1.25x wall clock if you parallelize), or is free if the model scores rather
  than decodes. **This belongs in the docs for any kind whose answer depends
  on the order of a list we send.**
- **Task conditioning is not a stable enum.** Google's flagship
  `gemini-embedding-2` has already dropped `task_type` in favour of free-text
  prompt instructions, and Voyage, Mixedbread, Contextual AI and Qwen3 all
  take a free-text instruction. Do not model the question as a closed union
  of task names. The market is converging on "state the question in prose",
  which is exactly what Jev's `instructions` field is.

**Conclusion for the design:** the generic backing is not embeddings and not
rerankers. It is a `LanguageModel` with a constrained answer set, or an NLI
model for the two kinds it can honestly serve. Rerankers cannot back this
capability in any direction that preserves its answer type, but the _reverse_
adapter works and has a home; §5.5 has the asymmetry and the reasoning.
Clustering belongs in `@effect-uai/retrieval` as a function over vectors,
next to `Rank.rrf`, not in this capability at all (§5.3).

## 4. The design

Settled over review; §9.1 is answered (see 4.6). Three modules:

| Module                                     | Holds                                                                               |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `core/src/decision-model/Decision.ts`      | the decision kinds, the definition, `assertKinds`, and the typed reads of an answer |
| `core/src/decision-model/DecisionModel.ts` | the service tag, `decide`, the response                                             |
| `core/src/math/Probability.ts`             | keyless math over a probability vector                                              |

### 4.1 A definition, then a call

The unit of work is a batch against one input (§1), and the batch is worth
declaring once rather than rebuilding per call: the instructions reference
field paths into the input shape, so the schema and the questions are one
artifact, and it is the artifact you review. So `make` builds a reusable
`Definition`, and `decide` applies it to data.

```ts
export type Labels = Readonly<Record<string, string>>
export type Levels = readonly [string, string, ...ReadonlyArray<string>]
export type Boundary = { readonly true?: string; readonly false?: string }

export type ClassifyDecision<L extends Labels = Labels> = {
  readonly _tag: "Classify"
  readonly instructions: string
  readonly criteria: L
}
export type RateDecision<V extends Levels = Levels> = {
  readonly _tag: "Rate"
  readonly instructions: string
  readonly criteria: V
}
export type ProbabilityDecision = {
  readonly _tag: "Probability"
  readonly instructions: string
  readonly criteria?: Boundary
}
export type Decision = ClassifyDecision | RateDecision | ProbabilityDecision

export const classify = <const L extends Labels>(decision: {
  readonly instructions: string
  readonly criteria: L
}): ClassifyDecision<L> => ({ _tag: "Classify", ...decision })

export const rate = <const V extends Levels>(decision: {
  readonly instructions: string
  readonly criteria: V
}): RateDecision<V> => ({ _tag: "Rate", ...decision })

export const probability = (decision: {
  readonly instructions: string
  readonly criteria?: Boundary
}): ProbabilityDecision => ({ _tag: "Probability", ...decision })

export type Decisions = { readonly [name: string]: Decision }

export type Definition<A, D extends Decisions = Decisions> = {
  readonly inputSchema: Schema.Codec<A, unknown, any, never>
  readonly decisions: D
}

export const make = <
  S extends Schema.Codec<any, any, any, never>,
  const D extends Decisions,
>(definition: {
  readonly inputSchema: S
  readonly decisions: D
}): Definition<S["Type"], D> => definition
```

**A plain tagged union, not `Data.TaggedEnum`.** Tried both. `Data.taggedEnum`
needs `WithGenerics<2>` plus a `this["A"] extends Labels ? this["A"] : Labels`
conditional to stop the constraint's index signature leaking into the answer,
and its constructors still erase `const` inference, so a rubric's wording
widens to `string` and restoring it costs a cast. Plain generic constructors
give label precision, literal rubric wording, the tuple arity and
`Match.discriminatorsExhaustive` with **zero casts** and no conditional. The
`_tag` discriminant is what does the typing; `Data.TaggedEnum` only adds
`$is` / `$match` (we use `Match` instead) and `Equal` / `Hash` (unused).

**The schema encodes on the way out**, which is why it is an Effect
`Schema.Codec` and not Standard Schema: Standard Schema is validate-only and
has no encode direction. This is not a deviation from house style,
[Tool.ts:256](../packages/core/src/tool/Tool.ts#L256) already has a dedicated
`Schema.Codec` overload. Encoding buys three things: a `Schema.Date` reaches
the model as an ISO string, a schema that omits a field keeps it from the
model, and encode failure is a typed error rather than `undefined` in the
body. The projection is the supported way to hold irrelevant or sensitive
context out of a request, which §1 lists as a documented failure mode.

`Schema.Json` covers a genuinely untyped input, so no `Json` type of ours
enters the public surface.

### 4.2 The answer is the distribution

```ts
export type ClassifyAnswer<L extends Labels = Labels> = {
  readonly _tag: "Classify"
  readonly labels: Readonly<Record<keyof L & string, number>>
}

export type RateAnswer<V extends Levels = Levels> = {
  readonly _tag: "Rate"
  /** Index-aligned with `legend`. */
  readonly levels: { readonly [K in keyof V]: number }
  readonly legend: V
}

export type ProbabilityAnswer = {
  readonly _tag: "Probability"
  readonly probability: number
}

export type Answer = ClassifyAnswer | RateAnswer | ProbabilityAnswer

export type AnswerFor<D> = D extends {
  readonly _tag: "Classify"
  readonly criteria: infer L extends Labels
}
  ? ClassifyAnswer<L>
  : D extends { readonly _tag: "Rate"; readonly criteria: infer V extends Levels }
    ? RateAnswer<V>
    : ProbabilityAnswer

export type Answers<D extends Decisions> = { readonly [K in keyof D]: AnswerFor<D[K]> }
```

Two decisions here, both of which cost a rewrite to learn.

**Labels are named, levels are positional.** A rubric's outcomes have no
names; they have an order. Keying them by `"0" | "1" | "2"` exists only
because JSON cannot have integer keys, and inheriting that put a
`Number(key)` parse in `expectedLevel` that returns `NaN` if anyone passes a
label distribution instead. A tuple mapped from `V` removes the parse, the
cast and the failure mode at once.

**No argmax and no `confidence` field.** The vendor sends both. Storing a
distribution and its argmax gives two sources of truth that can disagree, and
the vendor's `confidence` is undocumented, absent on the `noul` kind, and is
the exact number the whole confidence-gating pattern thresholds on. Derived
reads are in 4.3.

Audited against Jev's wire, the derived reads divide into three cases, and
being honest about it matters for how hard to defend each:

| Read            | On the wire?           | What it earns                                                                                  |
| --------------- | ---------------------- | ---------------------------------------------------------------------------------------------- |
| `margin`        | no                     | new information, nothing returns it                                                            |
| `ranked`        | no                     | `probabilities` is a record, which has no order                                                |
| `confidence`    | Classify and Rate only | uniformity: defined for all three kinds and identical across Layers                            |
| `winner`        | yes, `choice`          | consistency only                                                                               |
| `expectedLevel` | yes, `score`           | consistency only, plus the calibration caveat sits on a function rather than an inviting field |

The last two are a consistency choice, not a capability gain. The argument for
deriving them anyway: a `LanguageModel`-backed Layer receives a distribution
and would have to synthesize an argmax itself, so two Layers could differ on
ties. Deriving makes that a property of core.

**A provider's own `confidence` goes on its typed answer, not the common one.**

```ts
export type JevClassifyAnswer<L extends Labels = Labels> = Decision.ClassifyAnswer<L> & {
  readonly confidence: number
}
```

Reachable only by yielding the `Jev` tag, so generic code holding
`DecisionModel` never sees a second thing named confidence. The alternative,
an optional `confidence?: number` in core, follows
[WebSearch.ts:99](../packages/core/src/web-search/WebSearch.ts#L99)'s
"only from providers that rank" precedent, and is wrong here for a reason that
precedent does not have: an opaque wire number and a documented derived
function would share a name and a reader could not tell which is
authoritative. Note this is a _response_ widening where the repo's existing
widenings are on requests.

### 4.3 Reading an answer

Keyless math, reusable and with nothing to misindex:

```ts
// core/src/math/Probability.ts
export const confidence: (probabilities: ReadonlyArray<number>) => number // 1 - normalized entropy
export const margin: (probabilities: ReadonlyArray<number>) => number // top minus runner-up
```

Typed per kind, so no call can reach the wrong shape:

```ts
// core/src/decision-model/Decision.ts
export const probabilitiesOf: (answer: Answer) => ReadonlyArray<number>
export const confidence: (answer: Answer) => number
export const margin: (answer: Answer) => number

export const ranked: <L extends Labels>(
  answer: ClassifyAnswer<L>,
) => ReadonlyArray<{ readonly label: keyof L & string; readonly probability: number }>
export const winner: <L extends Labels>(
  answer: ClassifyAnswer<L>,
) => Option.Option<keyof L & string>

export const topLevel: (answer: RateAnswer) => number // argmax index
export const expectedLevel: (answer: RateAnswer) => number // probability-weighted mean
```

`confidence` and `margin` take any answer, including `Probability`, whose
distribution is `[p, 1 - p]`. `winner` returns `Option` because `Labels`
admits an empty record; `topLevel` returns a plain number because `Levels` is
a nonempty tuple by construction. `ranked` is the bridge to `Rank.rrf`.

Precedent: pure math over what a capability returns lives in its own module,
as `math/Vector.ts` does for embeddings and `retrieval/Rank.ts` for rankings.

### 4.4 The score contract

Goes on `ClassifyAnswer.labels` and `RateAnswer.levels`, and it is the most
useful paragraph we would ship:

> Probabilities sum to 1 within floating-point error and are comparable
> within one answer. Whether they are calibrated, so that a stated 0.8 means
> right about 80% of the time, is a property of the Layer and is documented
> per provider. No implementor promises calibration across requests, across
> decision kinds, or between a statement and its negation:
> `P(claim) != 1 - P(not claim)`. A threshold fitted against one model does
> not transfer to another.

Every clause is true of Jev by its own documentation, of every reranker
(§3), and of every LLM logprob path.

### 4.5 Naming, decided

| Concept         | Jev wire                 | Ours                                        | Why                                                                                                                                               |
| --------------- | ------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| the set         | none, inline per request | `Decision.make({ inputSchema, decisions })` | `Tool.make` / `Toolkit.make` precedent                                                                                                            |
| input witness   | n/a                      | `inputSchema`                               | `Tool.make` uses `inputSchema` for the witness and `Input` for the data                                                                           |
| input data      | `state`                  | `input`                                     | `Tool<Name, Input, …>`; `state` was the vendor's word                                                                                             |
| pick one label  | `type: "choice"`         | `classify`                                  | standard term, verb like its siblings                                                                                                             |
| ordered rubric  | `type: "score"`          | `rate`                                      | `score` collides with `RerankResult.score` and with the number itself                                                                             |
| is it true      | `type: "noul"`           | `probability`                               | jargon out. Keeping the return-type name over `check` / `test` is deliberate: it stops `if (answers.urgent)` on a float                           |
| question text   | `instructions`           | `instructions`                              | already house vocabulary, `Realtime.ts:87`                                                                                                        |
| the options     | `criteria` (3 shapes)    | `criteria`                                  | separate constructors pin the shape, so splitting it into `labels` / `levels` / `whenTrue` was ceremony; keeping it holds the wire mapping at 1:1 |
| model           | request                  | request                                     | every `CommonXRequest` in tree                                                                                                                    |
| distribution    | `probabilities`          | `labels` / `levels`                         | named for what the keys are, so the answer mirrors the question                                                                                   |
| definition type | n/a                      | `Definition`                                | not `Set`, per the global-collision rule                                                                                                          |

The one thing no name can carry is that the model does not decide, it reports
beliefs and the caller decides. That goes in the docs page's first paragraph.

### 4.6 §9.1, answered

**Answered yes, on the real modules.** Built and verified against rc.111
under `strict`, `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
Label keys survive `make` through `decide` into `answers`; reading an
undeclared label is a compile error; `Probability` answers have no `labels`;
the tuple-mapped `levels` comes out `readonly [number, number, number]` for a
three-level rubric; and `Record.toEntries` accepts
`Readonly<Record<keyof L & string, number>>` with no cast. Pinned in
`decision-model/Decision.test.ts`.

Three findings worth keeping:

- **`Data.taggedEnum` constructors do not apply `const` inference**, so a
  rubric's wording widened to `string` while its arity survived. This is what
  drove the move to plain constructors (§4.1); with them the wording stays
  literal and no cast is needed. Label keys were never affected either way,
  since object-type keys are always literal.
- **`legend` needed `Readonly<V>`.** A bare type parameter arrives mutable, so
  `legend: V` handed back a mutable tuple while `levels`, being a mapped type,
  was readonly. Caught only because the test asserted the type.
- **`A.isEmpty` does not exist in rc.111.** Use `.length === 0`.

No `MockDecisionModel` was written. The closest precedent is
`recipes/retrieve-and-rerank/recipe.test.ts`, which stubs `Reranker` and
`EmbeddingModel` inline with one documented cast, and the repo ships no
`MockReranker` or `MockEmbeddingModel` either. Add one when a consumer needs
scripted multi-call behaviour.

## 5. Extensibility, which is what the design has to get right

The user's real requirement is that adding a question kind later must not be a
redesign. The tagged-enum-plus-derived-answer shape gives that, with one
caveat that needs a policy.

### 5.1 Adding a kind is additive for callers, breaking for implementors

A new `Decision` arm is backwards compatible for existing call sites. But an
existing provider now receives a kind it cannot express, and it must not
silently omit the answer: the answer map would have a missing key where the
type says there is one. That is squarely **bucket 1** in
[capabilities.md](./capabilities.md): dropping it structurally breaks the
output, so it fails `AiError.Unsupported`. The shared guard belongs in core,
next to `EmbeddingModel.assertEncoding`
([EmbeddingModel.ts:131](../packages/core/src/embedding-model/EmbeddingModel.ts#L131)):

```ts
/** Fail `Unsupported` naming every decision whose kind this provider cannot
 *  express. Bucket 1: omitting an answer would break the answer map. */
export const assertKinds = (
  decisions: Decisions,
  supported: ReadonlyArray<Decision["_tag"]>,
  provider: string,
): Effect.Effect<void, AiError.AiError> => ...
```

It reports all offenders in one failure rather than the first, since the
definition is known up front and a caller fixing one at a time is wasted
round trips.

That single helper is what makes the enum safely extensible. Write it in step
2 even with one provider, so the policy is in place before it is needed. The
NLI backing in §5.5 is the case that exercises it first.

### 5.2 Kinds worth reserving room for, in descending order of likelihood

Not to be built now. Listed so the shape can be checked against them.

| Candidate  | Asks                               | Answer                                      | Why it is plausible                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Who could back it today                                                                |
| ---------- | ---------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `Subset`   | which of these apply, zero or more | a probability per label, not summing to 1   | multi-label is the most common real classification shape and Jev has **no** native form for it (the cookbooks fan out N Claims, which is correct but loses the joint view). The literature notes multi-label degrades zero-shot methods specifically                                                                                                                                                                                                                          | nobody natively; HF `zero-shot-classification` has `multi_label`, and an LLM can do it |
| `Ranking`  | order these candidates             | **per-candidate scores**, not a permutation | the one thing the market is actively shipping, and the conditioning-vs-decoding distinction in §3 says exactly which shape to pick. jina-reranker-v3.5 conditions over 64 candidates in one pass and still emits scores; Jev approximates it with a Choice over up to 255 ids (`cookbooks/semantic_find`). A permutation-shaped answer would be a trap: no score means no threshold and no `Rank.rrf` fusion, which the listwise literature names as its own primary drawback | Jina v3/v3.5 natively, Jev by approximation, any reranker pointwise                    |
| `Span`     | which part of the state            | an index or range, with a distribution      | extraction without generation is the documented workaround for a model that cannot generate. Jev's own answer is a Choice over line ids, so this may be sugar rather than a kind                                                                                                                                                                                                                                                                                              | Jev via Choice; an LLM                                                                 |
| `Quantity` | how many, how much                 | a calibrated number                         | the obvious hole, and the vendor is explicitly bad at counting and arithmetic. **Do not reserve room for this.** Nothing on the market does it and the one relevant model says it cannot                                                                                                                                                                                                                                                                                      | nobody                                                                                 |

Clustering is deliberately absent. See next.

### 5.3 Clustering does not belong here

It was the user's explicit question, so: no, and for a structural reason
rather than a taste one. Every other kind is a question about **one shared
state**. Clustering takes **N items and no state** and returns a partition.
It does not fit the request type, and forcing it in would make `state`
optional for one arm and meaningless for the rest.

More importantly, the research says the provider's job in clustering is only
to produce vectors. Four providers expose clustering-conditioned embeddings
(Gemini `CLUSTERING`, Cohere `clustering`, Jina `separation`, Nomic
`clustering`) and we already surface two of them. The decision (k-means,
HDBSCAN, v-measure) is client-side, which is also how MTEB evaluates it: "A
mini-batch k-means model with batch size 32 and k equal to the number of
different labels is trained on the embedded texts".

So clustering, if we ever want it, is a **function in
`@effect-uai/retrieval`** over vectors from `EmbeddingModel`, sitting next to
`Rank.rrf` and `Vector.cosine`. One caveat to document there: absolute cosine
values are anisotropic and model-specific, so density-based methods with
absolute distance thresholds are fragile across models even where k-means is
fine. Worth its own short plan; out of scope here.

### 5.4 What stays out of core entirely

Per the repo's own division of labour, and the rule that tool-running policy
stays out of core:

- **Taxonomy walking, beam search, cascades, composite weighted scoring,
  self-consistency repeats, threshold fitting.** All caller composition. All
  recipe material. The vendor's cookbooks are a ready-made recipe backlog.
- **A `DecisionTool`.** There is a `WebSearchTool` precedent for exposing a
  capability to a model, but a model asking a decision model to make its
  decision is a layer of indirection with no use case I can name.
- **A `DecisionModel` adapter over `Reranker` or `EmbeddingModel`.** See
  §5.5: the information is not there. The reverse direction does work and has
  a home, also §5.5.

### 5.5 Which adapters are honest, in which direction

This section replaces an earlier claim of mine that adapters in both
directions were equally unsound. That was wrong in one direction, and the
asymmetry is worth stating precisely because it decides where code lives.

**`DecisionModel` backed by a reranker or by embeddings: no.** Not a quality
judgment, a structural one. Every `DecisionModel` answer is a **probability
distribution**. A reranker has no distribution; it has an ordinal scalar that
its own vendors document as query-dependent and not comparable (§3). To
satisfy the answer type you would have to manufacture a distribution, by
softmax with a temperature you invented or by dividing by the sum, and then
`confidence` and `margin` computed from that shape are noise dressed as
calibration. `Claim` fails a second time over: it would substitute
"is this relevant to this query" for the caller's stated predicate, which is
exactly the gap the capability exists to close (§2.3) and exactly what the
no-automagic rule forbids. Embeddings fail the same way, with worse numbers
(§3).

**`Reranker` backed by `DecisionModel`: sound, but out of scope for now.**
The analysis below stands and is worth keeping, because it is the direction
someone will reach for and the asymmetry is not obvious. It is not being
built in the steps in §2.4 and Part 2; revisit it once the capability is in
use and someone actually wants to change a reranker's predicate.
`Reranker`'s contract is deliberately weak, [Reranker.ts:28-33](../packages/core/src/reranker/Reranker.ts#L28-L33):
"Scores order candidates within one call; no range or calibration is promised
and they are not comparable across requests." A per-candidate `Claim`
probability satisfies that and then some. Nothing is invented, and the
predicate is relevance because that is what `rerank` asks for. One call per
candidate, since no decision API batches N states (§9.4), bounded with
`Effect.all`; the vendor's own rerank cookbook runs 1,200 such calls for
$0.0645.

**Where it lives: `@effect-uai/retrieval`, not core.** The precedent is
already in tree and exact:
[`Chunking.layer`](../packages/retrieval/src/Chunking.ts#L277) serves the
**core `Chunker` tag** from the retrieval package with no provider involved,
and `docs/retrieval/index.md` already describes that package as the one that
"carries the pieces that are plain functions rather than providers". A
`Reranker` Layer over `DecisionModel` is the same move, and keeping it there
avoids a capability-over-capability dependency inside core.

Sketch:

```ts
/** Serve the core `Reranker` tag by asking a decision model one relevance
 *  Claim per candidate. Scores are `P(relevant)`, which is stronger than
 *  the Reranker contract requires. `concurrency` bounds the fan-out. */
export const rerankerLayer = (options: {
  readonly model: string
  readonly ask?: (query: string) => string
  readonly concurrency?: number
}): Layer.Layer<Reranker, never, DecisionModel> => ...
```

**Honest positioning, which the docs must carry.** This is not a way to avoid
paying for a reranker. A purpose-built cross-encoder beats a general model on
quality, cost and latency simultaneously (§6), and one rerank call is about
130ms against N decision calls. The reason to reach for this Layer is that it
is **the only way to change the predicate**: "rank by whether this passage
contradicts the claim", "rank by recency-adjusted relevance", "rank by
whether this candidate is safe to show a minor". No reranker API accepts
that, and the ones with an `instruction` field apply it, in Contextual AI's
own words, "after considering relevance".

Given this Layer, the fused configuration from §2.2 would need no new code at
all: one `EmbeddingModel` ordering, one `Reranker` ordering served by
`DecisionModel`, `Rank.rrf` over the two. That remains the cheapest way to
find out whether the +0.090 holds on our own data, which is why the Layer is
deferred rather than rejected.

**A genuine partial implementation does exist, from a different backing.**
Natural-language-inference models return a real distribution over
`{entailment, neutral, contradiction}`, so `P(entailment)` is a legitimate
`Claim.probability` with the caller's predicate intact, and HF's
`zero-shot-classification` task (with `candidate_labels` and
`hypothesis_template`) returns an honest distribution over labels, which is a
legitimate `Choice`. `Score` has no NLI form, so `assertKinds` rejects it.
That is a real partial: two kinds supported, one unsupported, nothing
invented. It is also the case that makes `assertKinds` earn its keep before a
second kind is ever added. Quality is the catch (0.676 mean macro F1 for the
best zero-shot DeBERTa across 28 datasets, and 0.513 on Banking77), so treat
it as a portability floor rather than a performance option. Not in the first
three steps; it is listed here because it is what proves the partial-support
mechanism is real rather than theoretical.

## 6. The second implementation, which is the point

A core tag with one provider is a wrapper. The generic value comes from
`LanguageModel`-backed `DecisionModel`, and that is buildable in this repo
today because `LanguageModel` and `StructuredFormat` already exist.

Mechanism: constrain the answer set, read the token logprobs over the
constrained alternatives, renormalize to a distribution. This is exactly what
Qwen3-Reranker does internally (§2.3), and the literature is clear that a
renormalized max-softmax-probability is a usable abstention signal even when
the absolute value is miscalibrated, needing "only a small amount of labeled
data to choose the MSP threshold".

Two things make this harder than it sounds, and both must be designed for
rather than discovered:

**Logprobs are a per-model runtime capability, never a per-provider static
flag.** Verified: Anthropic documents `logprobs` / `top_logprobs` as "Ignored"
with the response field "Always empty"; xAI silently ignores them on
grok-4.20+; Groq's fields exist but are "not yet supported by any of our
models"; Cohere v2 returns the chosen token's logprob with **no alternatives**,
which makes renormalization impossible. The dangerous case is silent ignore: a
well-formed response, no logprobs, no error. This is precisely the epistemic
regime `internal-docs/capability-negotiation-design.md` was written for, and a
good first real consumer for it. A static marker will not do the job.

**The documented fallback is verbalized confidence, and it is not a
degradation.** When logprobs are unavailable, asking the model to state its
own confidence is reported to be _better_ calibrated for RLHF'd models (around
50% relative ECE reduction), with self-consistency sampling as the more
expensive alternative. So the adapter has two modes and should say which one
produced a given distribution, rather than pretending they are the same.

**And this adapter is the portability path, not the performance path.** The
evidence that an LLM is a poor substitute for a purpose-built small model is
strong and points in one direction. A vendor head-to-head over 17 benchmarks
puts zerank-1 at 0.777 nDCG@10 against gpt-5-mini's 0.698 while being 17x
faster (p50 129.7ms vs 2,180ms) and 10x cheaper, so the small model wins on
quality, cost and latency simultaneously (vendor-reported, discount
accordingly). Naver Labs found the same independently: a DeBERTa-v3
cross-encoder on top of SPLADE-v3 beats GPT-4 on TREC-COVID, TREC-NEWS and
Touche-2020. FLOPs-normalized, pointwise scoring dominates generative
approaches by roughly 10x, and "scaling up hurts efficiency far more than it
helps". TREC's own RAG track quietly dropped its listwise reranker between
2024 and 2025.

There is exactly one documented regime where that inverts, and it is worth
knowing because it is where this whole category is heading: **reasoning-
intensive retrieval.** On BRIGHT, the 2023-24 listwise rerankers are _worse
than BM25_, and what moves the number is reasoning (Rank1's own ablation:
17.5 without, 27.5 with). Once you pay for reasoning, groupwise becomes the
cheap option rather than the expensive one, because one chain of thought
amortizes over many candidates instead of running per candidate: ReasonRank
reports being 2 to 2.7x _faster_ than pointwise Rank1, and GroupRank 3.4s per
query against a pointwise 11.1s.

That pair of regimes is the sharpest statement of what a decision model is
for. It earns its place not by being a better generic LLM judge, but by being
small and fast enough to beat an LLM in the normal regime **while still
accepting an arbitrary predicate**, and by amortizing whatever work it does
across the question set rather than per question. Which is precisely the
"one state, N questions, one call, 12x cheaper" property from §1. Our
abstraction should make that batching the obvious thing to do, and the
`LanguageModel`-backed Layer should be documented as the compatibility
fallback that makes a decision program portable, not as a performance peer.

Consequence for §4.3: the calibration promise is per Layer, and the
`LanguageModel`-backed Layer's honest statement is "renormalized token
probability, uncalibrated" or "verbalized, uncalibrated". Which argues for a
`CalibratedDecisions` phantom marker for callers who threshold, satisfying
`capabilities.md`'s bar (failure not degradation, layer-level, a real
consumer). I would **not** ship it with the tag: `capabilities.md:519` records
that `Reranker` deliberately ships marker-free because no candidate passed
the bar, and the same restraint applies until a caller actually needs the
guarantee.

## 7. Provider mapping

### 7.1 Naming, which needs a decision before anything is written

`@effect-uai/typesafe` is a bad name in this repo: it reads as "type-safe
helpers" in a TypeScript library, and the `Typesafe` trademark question in
software is unresolved. Recommendation: **`@effect-uai/typesafe-ai`**, module
`src/Jev.ts`, provider tag
`"@betalyra/effect-uai/providers/typesafe-ai/Jev"`. Alternative:
`@effect-uai/jev` named after the model, which is how `responses` is named
after a protocol rather than a vendor, but it breaks the one-package-per-brand
rule if TypeSafe ships a second model. Debut at the current fixed-group
version (0.16.0 today), per the fixed-group rule.

### 7.2 Mapping is close to mechanical

| Common                               | Wire                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `state`                              | `state`, unchanged                                                                    |
| `questions` keys                     | `questions` keys, unchanged                                                           |
| `Choice { ask, labels }`             | `{ type: "choice", instructions: ask, criteria: labels }`                             |
| `Score { ask, levels }`              | `{ type: "score", instructions: ask, criteria: levels }`                              |
| `Claim { ask, whenTrue, whenFalse }` | `{ type: "noul", instructions: ask, criteria: { true, false } }`                      |
| `model`                              | `model`, narrowed to `"jev-latest" \| "jev-preview" \| "jev-1.13.0" \| (string & {})` |
| answer `labels` / `levels`           | `probabilities`                                                                       |
| answer `legend`                      | `legend`                                                                              |
| `usage`                              | `{ input_tokens, output_tokens }`                                                     |

Provider-typed extras that stay off the Common request: the vendor's
`confidence` on the answer (§4.2), and nothing else today. That is unusually
clean, and is itself the hazard of going core-first: a one-to-one mapping to a
single vendor is what "premature abstraction" looks like from the inside.
§2.4 answers it by checking the shape against the NLI and `LanguageModel`
backings before the tag is written, rather than by deferring the tag.

Error mapping follows the house table: 401 `AuthFailed{subtype:"auth"}`, 422
`InvalidRequest`, 429 `RateLimited`, 529 `Unavailable`, 5xx `Unavailable`,
transport `Unavailable`. Over-budget state is `ContextLengthExceeded` (64k
total, 32k state plus longest question). Config is the house shape:
`{ apiKey: Redacted.Redacted; baseUrl?: string }`, read with `Config.redacted`.

### 7.3 Two things to verify against the live API before implementing

- **`model` vs `selectedModels`.** `primitives/score.md` shows a request body
  with `"selectedModels": ["jev-latest"]`, while both `api.md` and the SDK's
  `SystemOneRequestPayload` have a single `model: string`. The SDK types are
  almost certainly authoritative and the doc stale, but this is the request's
  required field and worth one live call.
- **The OpenRouter path.** OpenRouter lists `typesafe/jev-1.13` and
  `~typesafe/jev-latest` (32K context, $0.042/M in, $0/M out) behind its
  OpenAI-compatible surface at `https://openrouter.ai/api/v1`. The Jev request
  shape is not a chat completion, so either OpenRouter maps it somehow or the
  listing is misleading. If the systemone shape is reachable through
  OpenRouter, a gateway story comes free; if it is only reachable as chat
  messages, it is useless to us and should not be documented. Cloudflare
  Workers AI also lists `typesafe/jev`.

## 8. Recipes, if this ships

Two, both of which exist to demonstrate something the evidence supports
rather than to demo the API.

**`decision-routing`.** Classify the incoming request over a small label set,
gate on confidence, route to a cheap model, an expensive model, or a human.
This is the independently reported flagship use case, with numbers: a 4-tier
choice at 0.64 to 0.67s median and $0.000025 per call, 100% correct over 40
calls, against 2.1s for a small LLM. It sits next to the existing
`model-escalation` and `multi-model-fallback` recipes and reuses nothing from
them (recipes never depend on recipes).

**`fused-rerank`, deferred with the §5.5 Layer it depends on.** Retrieve with
embeddings, score the top k with a `Claim` per candidate, fuse the two
orderings with `Rank.rrf`. This is the configuration that survived the one
study controlling for judge circularity: **+0.090 nDCG@10, +0.064 under
independent labels**, where the same model as a standalone reranker scores
**-0.028**. When it does get written, the README should carry those three
numbers and the reason, because the interesting result is that replacing the
reranker is wrong and adding a second signal is right. It can be written
against `decide` directly rather than waiting on the `Reranker` Layer, which
is the cheaper path if we only want the measurement.

Another candidate, deliberately deferred: a decision-model-backed approval
policy over `Approval.fromMap`
([Approval.ts:167](../packages/core/src/tool/Approval.ts#L167)), where the
confidence gate decides whether a tool call runs, asks, or is rejected. It is
the best fit in the repo for the confidence-gated third branch, and it is also
where a miscalibrated probability does the most damage. Worth building only
after the calibration question in §9.3 has an answer we produced ourselves.

## 9. Open questions to settle before building

**9.1 Does the derived answer map actually typecheck? Answered yes, see
§4.6.** It does, with plain generic constructors rather than
`Data.TaggedEnum`, and with no casts. Pinned in
`decision-model/Decision.test.ts`.

**9.2 Distribution-only, or mirror the vendor's `confidence`?** §4.2 argues
for our own function. The counter-argument is real: if Jev's confidence is
computed from something we do not see, recomputing it from the distribution
silently produces a different number than the vendor's own docs and cookbook
thresholds use. Cheapest resolution: one live call, compute both, compare. If
they match, our function is strictly better. If they do not, the vendor's
number carries information the distribution does not, and it belongs on the
common answer with its opacity documented.

**9.3 Is it calibrated, on our data?** Nobody has published vendor
calibration evidence: no reliability curve, no ECE, no Brier score, no
ablation isolating the claimed RLCD training. One independent probe reports
ECE 0.0313 on 1,200 MMLU items. Since calibration is the entire reason to
prefer this over a prompted LLM, and since §4.3's contract text hinges on it,
we should measure it once on a task we care about before the docs claim
anything. Also worth reproducing: the independent finding that option
**position** changes accuracy (12/16 correct when the target option is first,
16/16 when last) and that adding irrelevant options shifts the ratio between
the existing ones.

Position bias deserves its own measurement rather than a footnote, because
the general result is severe: Google Research measured ranking metrics
dropping "by more than 50% when the input document order changes", with
RankGPT falling from 65.80 to 32.77 nDCG@10 on reversal alone. If `Choice`
over a long label list inherits any of that, it needs a line in the docs and
probably a shuffle-and-average helper in core. Note the price of the known
mitigation before promising one: permutation self-consistency costs 20x
tokens for a 0.4% to 5% relative gain, though only about 1.25x wall clock if
the calls run in parallel. Cheap to implement here given `Effect.all` with a
concurrency bound, but it is a real bill.

**9.4 Is the batch enough, or do we need a second method?** The whole design
assumes one state per call. Reranking wants one question against N
independent states, and today that is N calls (the vendor's own rerank
cookbook makes 1,200 of them for 40 queries). Nothing in the wire supports
batching those. Leaving it as caller-side `Effect.all` with a concurrency
bound is correct and cheap, but if a provider ever ships an N-state batch
endpoint the request type changes shape, not just gains a field. Worth a note
in the doc comment so it is a known edge rather than a surprise.

**9.5 Does the vendor survive?** Not a design question, but it is a
dependency question. Three days old, waitlist-gated, no named customers, no
published weights or on-prem path, no revenue disclosed, and open-weight
reimplementations appeared on Hacker News within 24 hours. The staging in
§2.4 is partly insurance against this: a provider package is cheap to
deprecate, and a core tag with a `LanguageModel`-backed Layer survives the
vendor's disappearance entirely.

## 10. Recommendation in one paragraph

Settle §9.1 first, with `expectTypeOf` in a real test file, because it is the
only open question that changes the tag's shape. Then add a core
`DecisionModel` tag (§4) with the `assertKinds` guard (§5.1), the confidence
and distribution helpers as pure functions (§4.2), a `MockDecisionModel`, and
`@effect-uai/typesafe-ai` registering both the `Jev` and `DecisionModel` tags
(§7), plus one recipe (`decision-routing`) and a docs page whose first
paragraph says the model does not decide (§4.4). Follow with the one Layer
that makes it a capability rather than a wrapper: `LanguageModel`-backed, in
core (§6). Keep clustering out (an embedding function over vectors, §5.3),
keep `DecisionModel`-over-`Reranker` out permanently (the distribution is not
there to recover, §5.5), leave `Reranker`-over-`DecisionModel` for later
(sound, but nobody needs it yet, §5.5), defer markers (§6), and write the
score contract in §4.3 before the docs page, because the honest version of it
is the most useful thing we would ship.

Part 2 turns this into a checklist.

---

# Part 2. Implementation plan

Detail lives in Part 1; this is the order of work and the acceptance line for
each step. Each step is a separate PR that builds, typechecks and tests green
on its own. Section references point back to Part 1.

No new `AiError` variant is needed: `Unsupported` (§5.1) and the standard
status mapping (§7.2) cover everything.

### Step 0. Prove the type before anything else. DONE

Folded into Step 1 rather than done on a throwaway branch, since the real
modules answer it directly. Result and findings in §4.6.

### Step 1. The core capability. DONE

- `packages/core/src/decision-model/Decision.ts`: `Labels` / `Levels` /
  `Boundary`, the `Decision` tagged union, the `classify` / `rate` /
  `probability` constructors,
  `Decisions`, `Definition`, `make`, the three answer types, `AnswerFor`,
  `Answers`, `assertKinds`, and the typed reads `probabilitiesOf` /
  `confidence` / `margin` / `ranked` / `winner` / `topLevel` /
  `expectedLevel`. Score contract on `ClassifyAnswer`.
- `packages/core/src/decision-model/DecisionModel.ts`: `DecideUsage`,
  `DecideResponse`, `CommonDecideRequest`, `DecisionModelService`, the
  `DecisionModel` tag (`"@betalyra/effect-uai/DecisionModel"`), `decide`.
  `@experimental` on the tag and both module headers.
- `packages/core/src/math/Probability.ts`: `confidence` / `margin` over a
  keyless `ReadonlyArray<number>`.
- `packages/core/src/index.ts` and `packages/core/package.json`: `./Decision`,
  `./DecisionModel`, `./Probability` subpaths.
- Tests: `math/Probability.test.ts` (12) and
  `decision-model/Decision.test.ts` (8), including the §4.6 type assertions
  and the case where `confidence` and `margin` disagree.

**Done:** `tsc --noEmit` clean, full core suite 283 tests green, `oxfmt`
applied. No `MockDecisionModel`, see §4.6.

**Done when:** `pnpm typecheck` and `pnpm test` pass, and the helpers are
tested against hand-computed values.

### Step 2. The provider package. CODE DONE, live call outstanding

Built as `@effect-uai/typesafe-ai` (name decision in §7.1 taken):
`src/models.ts` (`JevModel`), `src/Jev.ts` (the `Jev` tag, `JevDecideRequest`
narrowing `model`, `Schema.Struct` wire codecs, the house status table,
`make` + `layer` registering both `Jev` and `DecisionModel`), `src/index.ts`,
`README.md`, `LICENSE`, `tsconfig.json`, `tsdown.config.ts`. Registered in
`.changeset/config.json`'s `fixed` group and in `recipes/package.json`.

No tests: the recipe in Step 3 is the verification, so a unit test here would
only restate the codec.

Two implementation notes worth keeping:

- **`JevAnswerFor` is an intersection, not a per-kind branch.**
  `Decision.AnswerFor<D> & ReportedConfidence<D>` where `ReportedConfidence`
  resolves to `unknown` for `Probability`. Branching per kind compiles but
  makes `JevAnswers<D>` unassignable to `Answers<D>`, because TypeScript
  cannot see one deferred conditional as a subtype of another. An
  intersection is always assignable to its members, so the generic
  registration forwards with **no cast**.
- **Rubric probabilities are read positionally against the rubric we sent.**
  The wire returns `probabilities` keyed by level index as a string; a
  missing index is a decode failure rather than a hole in the tuple, and
  `legend` comes from the request rather than the response so the indices are
  aligned by construction.

Checks: `pnpm -r typecheck` clean across all 31 projects, `pnpm build` clean,
full suite 641 tests green.

**Still outstanding, needs a key:** one live call, and with it the answers to
§7.3 (`model` vs `selectedModels`) and §9.2 (our `confidence` versus Jev's),
written back into this file.

### Step 2 remainder. The live call. DONE, §9.2 still open

Ran `decision-triage` against the real API, 3 tickets, 5 decisions each.

**§7.3 answered.** The request field is **`model`**. `bearerToken` +
`POST /v1/systemone` is accepted exactly as written, and the response decoded
without adjustment. The `selectedModels` in `primitives/score.md` is a stale
doc; the SDK types were right.

**Measured, for the docs:** 566 to 575 input tokens for 5 decisions over a
short ticket, so the questions dominate a small input. About $0.000024 per
call. Cold call 690ms, warm calls 220ms and 270ms.

**A finding that changed the recipe.** On a four-label classify the model
returned `account 0.74 / billing 0.13 / other 0.13 / technical 0.00`, which
normalized entropy scores at **0.46**. A `confidence < 0.6` gate therefore
escalated a decisive answer. Normalized entropy moves with label count: a
threshold that reads as reasonable on two labels demands roughly 0.85 top
mass on four. `Probability.confidence`'s own docstring already warned about
this and the recipe ignored it. The gates now read top probability and
`margin`, both length-stable, and the README documents why with these
numbers. **This belongs on the capability's docs page too**, since it is the
single easiest way to misuse the API.

**Saturation, relevant to §9.3.** Two of three tickets came back with exactly
`1.00 / 0.00 / 0.00 / 0.00`. Distributions saturate, so entropy-confidence
hits exactly 1 and any calibration claim at the top of the range is
untestable from the output alone. Worth keeping in mind before the docs
repeat the vendor's calibration framing.

**Run-to-run drift on identical input.** Two runs of the same three tickets
gave `account 0.74` then `0.75`, and rubric expected values `2.93` then
`2.99`, `0.59` then `0.52`. Small, and consistent with the vendor's own
reported ~0.0102 mean probability stddev across repeats, but it means **a
threshold sitting on a boundary will flip between runs**, so the docs should
say to leave headroom rather than tune to three decimals.

**Tie order is wire order, not ours.** Among saturated zeros the printed
ranking reordered between runs, because `ranked` keeps first-seen order and
first-seen is whatever key order the response arrived in. `ranked`'s doc
comment says "ties keep first-seen order", which is accurate but easy to
misread as stable. Callers must not depend on tie order; worth a line in the
docs page.

**§9.2 is still open.** The recipe yields the generic `DecisionModel` tag, so
Jev's own `confidence` never surfaced. Answering it needs one run that yields
the `Jev` tag and prints `answers.department.confidence` beside
`Decision.confidence(answers.department)`. Deliberately not added to the
recipe, which has to stay provider-agnostic; do it as a one-off.

The six `RELEASING.md:46-96` steps for a new npm package remain outstanding
and are release work, not build work.

### Step 3. Recipe and docs

- `recipes/_shared/model.ts`: a `decisionEntries` record and a
  `decisionModelLayer`, following `rerankerLayer` at `:522-526`.
- `recipes/decision-routing/{recipe.ts,app.ts,run.ts,README.md}` per §8.
  `recipe.ts` names `DecisionModel`, never `Jev`.
- `docs/decisions/index.md` (frontmatter `title` / `description` / `icon`)
  whose first paragraph says the model does not decide (§4.4), and
  `docs/decisions/providers/typesafe-ai.md` on the provider-page template.
  The score contract and the jaggedness caveats from §1 belong on the
  provider page, not the capability page.
- Sidebar group in `webpage/astro.config.mjs`; cheat-sheet entry in
  `skills/effect-uai/SKILL.md`.

**Done when:** the recipe runs on Node, Bun and Deno, and `pnpm build` is
clean.

### Step 4. The `LanguageModel`-backed Layer

- `packages/core/src/decision-model/fromLanguageModel.ts` plus its subpath:
  constrain the answer set, read renormalized top-logprobs, fall back to
  verbalized confidence, and say on the response which mode produced the
  distribution (§6).
- Handle silent-ignore explicitly: a well-formed turn with no logprobs is the
  dangerous case, not an error (§6).
- Tests use `MockProvider`, not a live model.
- Docs: a "portable fallback" section on the capability page stating plainly
  that this is for portability, not performance, with the §6 numbers.

**Done when:** the `decision-routing` recipe runs unchanged against both
Layers.

### Out of scope, recorded so it stays out

Phantom markers including `CalibratedDecisions` (§6), further question kinds
(§5.2), clustering (§5.3), `DecisionModel` backed by a reranker or embeddings
(§5.5, permanently: it requires inventing a distribution), `Reranker` backed
by `DecisionModel` (§5.5, sound but unneeded for now), the NLI backing
(§5.5), `fused-rerank` (§8), the approval-policy recipe (§8, gated on §9.3).

### Why this order

Step 0 is first because it is the only open question that changes the public
shape. Step 1 precedes Step 2 so the provider is written against the generic
types rather than the generic types being back-fitted to the wire, which is
the failure mode §7.2 warns about. Step 4 is last but is the step that
justifies the core tag, so it should not be allowed to drift: if it has not
landed a release after Step 3, that is a signal the tag was premature after
all.
