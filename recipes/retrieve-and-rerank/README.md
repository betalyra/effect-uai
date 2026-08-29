---
title: Retrieve and rerank
description: Search ranks the right answer first by a hair. A model rereads the shortlist and makes the gap obvious.
source: recipes/retrieve-and-rerank
icon: PiRanking
---

A help center says almost the same thing a dozen times, changing one word each
time. Priority support: included on Team with an annual commitment, on Scale
with an annual commitment, on Enterprise outright, or month to month with no
commitment at all.

Ask "can I get priority support without committing to an annual plan?" and
cosine does put the right sentence first. It puts its exact opposite second,
**0.006 behind**. Reword the question and the two swap.

Rerank the same fifteen candidates and the gap is 0.47. A reranker reads the
question and the candidate together, so the qualifier that separates them
(month-to-month not annual, EU not US, audit not application) is something it
can weigh. Too slow for a corpus, free on a shortlist.

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

Watch the handoff. `results[].index` addresses the candidate list you sent, not
your corpus:

```ts
const answerSet = results.map((r) => candidates[r.index].id)
```

## Say which side you are embedding

A question and the passage answering it are different kinds of text, and
retrieval models expect to be told which is which:

```ts
embed({ model, input: question, task: "query" })
embedMany({ model, inputs: documents, task: "document" })
```

Skip it and you lose recall on the queries you care about most. See
[embeddings](/embeddings/) for how each provider spells it.

## Run it

```sh
JINA_API_KEY=jina_... pnpm tsx recipes/retrieve-and-rerank/run-node.ts
```

One key covers both stages. Add `LLM_API_KEY` to generate the answer too;
without it you still get the rankings.

```sh
... run-node.ts --question "How long are audit logs kept in the EU region?"
... run-node.ts --candidates 25 --keep 6
```

You get two tables over the same candidates, `by cosine` then `after rerank`,
each showing the margin between its top two. The order stays broadly similar;
the margin grows by an order of magnitude. Also worth watching is what drops
out: on the audit-log question cosine ranks _Application logs are kept for 14
days in the EU region_ second, and the reranker pushes it below two sentences
actually about audit logs.

## Point it at your own documents

Replace `corpus.ts`. The rest is flags:

- `--embed-model` / `--rerank-model`
- `--candidates`, how many documents the reranker sees. 10 to 30 for a corpus
  this size, around 100 once you retrieve from thousands.
- `--keep`, how many reach the model.

Documents longer than a paragraph should be chunked first, then reranked as
chunks: a reranker scores a passage against a question, and a whole document
buries the passage. See [retrieval](/retrieval/).

## Scores are ranks, not probabilities

Rerank scores order candidates within one call. They are not calibrated and not
comparable between calls, so cut by rank (`topN`, or "keep the top 4"), never by
a fixed threshold like `score > 0.8`.

Read the margin relatively. A top-1 clearing the runner-up by half a point is a
different situation from one clearing it by a hundredth, and only the first is
worth answering from.

## See also

- [Reranking](/reranking/): the capability, the score contract, and the
  multimodal option.
- [Agentic search](/recipes/agentic-search/): the same two stages with a keyword leg
  and a database.
- [Basic embedding](/recipes/basic-embedding/): the first stage on its own.
