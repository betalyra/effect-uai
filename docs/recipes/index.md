---
title: Recipes
description: Working examples of common agent patterns.
---

Recipes live in [`recipes/`](https://github.com/betalyra/effect-uai/tree/main/recipes)
in the repo. Each one is real, type-checked code composed from core
primitives. Their READMEs are mirrored as pages in this section - the page
*is* the recipe's `README.md`, sitting next to its `index.ts` and
`index.test.ts` in the repo.

Currently scaffolded:

- [Multi-model fallback](/recipes/multi-model-fallback/) - fall back across
  providers on `RateLimited` / `Unavailable`.
- [Auto-compaction](/recipes/auto-compaction/) - summarize history when
  token / turn budget is exceeded.
- [Pause and resume](/recipes/pause-resume/) - checkpoint after each turn,
  resume later via `previousResponseId`.
- [Mid-stream abort](/recipes/mid-stream-abort/) - cancel the loop and the
  upstream HTTP request via scope-based cleanup.
