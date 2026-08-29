---
title: Retrieve and rerank
description: Your search returns documents about the question that never answer it. A rerank pass fixes the order, and this recipe prints the before and after so you can see it happen.
source: recipes/retrieve-and-rerank
icon: PiFunnel
---

Embedding similarity is confident about the wrong things.

A help center says almost the same thing a dozen times over, changing one word
each time: priority support included on Team with an annual commitment,
included on Scale with an annual commitment, included on Enterprise, or bought
month to month with no commitment at all. Ask "can I get priority support
without committing to an annual plan?" and cosine does put the right sentence
first. It puts its exact opposite second, **0.006 behind it**.

That margin is noise. Reword the question and the two swap. You cannot set a
threshold on it, cannot drop the tail, and cannot tell a confident hit from a
coin flip. Rerank the same fifteen candidates and the gap becomes 0.47.

A reranker reads the question and each candidate together, so the qualifier
that separates them (month-to-month, not annual; EU, not US; audit, not
application) is something it can actually weigh. That costs too much to run
over a corpus and nothing to run over a shortlist, which is why it goes second.

**Scenario.** An 85-document help center built out of these near-duplicate
clusters. Cosine picks 15 candidates, the reranker re-scores them, and the top
few become grounded context for the answer. Watch the `top-1 margin` under each
table: that, more than the ordering, is what the second stage buys you.

## Two stages

```ts
// wide and cheap: every document, one vector each
const candidates = documents
  .map((doc, id) => ({ id, score: Vector.cosine(queryVector, vectors[id]) }))
  .sort(byScore)
  .slice(0, 15)

// narrow and sharp: the query and each candidate, read together
const { results } =
  yield *
  rerank({
    model: "jina-reranker-v3.5",
    query: question,
    documents: candidates.map((c) => documents[c.id]),
    topN: 4,
  })
```

The one thing to get right is the handoff. `results[].index` addresses the
candidate list you sent, not your corpus, so map it back through the
candidates before you use it:

```ts
const answerSet = results.map((r) => candidates[r.index].id)
```

## Say which side you are embedding

A question and the passage answering it are not the same kind of text, and
retrieval models expect to be told which is which:

```ts
embed({ model, input: question, task: "query" })
embedMany({ model, inputs: documents, task: "document" })
```

Skip it and you lose recall on exactly the queries you care about. See
[embeddings](/embeddings/) for how each provider spells it.

## Run it

```sh
JINA_API_KEY=jina_... pnpm tsx recipes/retrieve-and-rerank/run-node.ts
```

One key covers both stages: Jina serves the embeddings and the reranker. Add
`LLM_API_KEY` to also generate the answer; without it you still get the
rankings.

```sh
# the other demo questions
... run-node.ts --question "How long are audit logs kept in the EU region?"
... run-node.ts --question "How do I roll back a deployment on the free tier?"

# a wider shortlist, more context
... run-node.ts --candidates 25 --keep 6
```

You get two tables over the same candidates, `by cosine` then `after rerank`,
each with the margin between its top two. Expect the ordering to be broadly
similar and the margin to grow by an order of magnitude. Watch the documents
that drop out of the top few as well: on the audit-log question cosine ranks
_Application logs are kept for 14 days in the EU region_ second, and the
reranker pushes it below two sentences that are actually about audit logs.

## Point it at your own documents

Replace `corpus.ts`. Everything else is parameterized:

- `--embed-model` / `--rerank-model` to change models.
- `--candidates` for how many documents the reranker sees. More catches more
  and costs a little latency: 10 to 30 suits a corpus this size, ~100 once you
  are retrieving from thousands.
- `--keep` for how many documents reach the model.

If your documents run longer than a paragraph, chunk them first and rerank the
chunks. A reranker scores a passage against a question, and a whole document
buries the passage.

## Scores are ranks, not probabilities

Rerank scores order candidates within one call. They are not calibrated and not
comparable between calls, so cut by rank (`topN`, or "keep the top 4"), never
by a fixed threshold like `score > 0.8`.

The margin is still worth reading, just relatively: a top-1 that clears the
runner-up by half a point is a different situation from a top-1 that clears it
by a hundredth, and only one of those is worth answering from.

## See also

- [Reranking](/reranking/): the capability, the score contract, and the
  multimodal option.
- [Basic embedding](/recipes/basic-embedding/): the first stage on its own.
