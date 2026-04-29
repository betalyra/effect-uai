# Recipes

Working examples of common agent patterns, each composed from
`@betalyra/effect-uai-core` primitives. Recipes are not published — they are
type-checked, runnable demonstrations that double as living regression tests
for the primitive surface.

## Available recipes

- [`multi-model-fallback/`](./multi-model-fallback/) — fall back across
  providers on `RateLimited` / `Unavailable`.
- [`auto-compaction/`](./auto-compaction/) — summarize history when token /
  turn budget is exceeded.
- [`pause-resume/`](./pause-resume/) — checkpoint after each turn, resume
  from a saved checkpoint via `previousResponseId`.
- [`mid-stream-abort/`](./mid-stream-abort/) — cancel the loop and the
  upstream HTTP request via scope-based cleanup.

Each recipe folder contains its own `README.md` describing the scenario.
Implementations live in `index.ts`; tests in `index.test.ts`.
