---
title: Reranking
description: Better top-K than cosine — cross-encoder relevance scoring after retrieval.
---

The top-K vectors by cosine are not always the top-K results.

Embedding cosine compresses the relationship between a query and a
document into one number per side. That's good enough to filter a
million documents down to fifty candidates. It's often not good enough
to pick the three the user actually wants. Rerankers re-score those
fifty with a cross-encoder that sees the query and document together,
trading throughput for accuracy where it matters.

The shape is small: one query, a list of documents, scores back. Same
HTTP plumbing as embeddings, different model class.

## Coming soon

`@effect-uai/core` will ship a `Reranker` service tag and provider
implementations, planned in this rough order:

- **Jina** — `jina-reranker-v3` and `jina-reranker-m0` (multimodal,
  multilingual).
- **Cohere** — `rerank-v3.5` and successors.
- **Voyage** — `rerank-2` and `rerank-2-lite`.
- **Mixedbread** — `mxbai-rerank-large-v2`.

The four providers' wire shapes already converge on
`POST /rerank { model, query, documents } → { results: [...] }`, so
one common service tag covers all of them with provider-typed tags
extending it for per-provider knobs.

## Show interest

Want this sooner, or have a provider you'd like to see prioritised?
Open or +1 the
[reranking tracking issue](https://github.com/betalyra/effect-uai/issues/new?title=Capability%3A+Reranking&body=I%27m+interested+in+reranking+support.+Provider%28s%29%3A+%0A%0AUse+case%3A+).
