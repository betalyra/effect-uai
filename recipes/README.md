# Recipes

Working examples of common agent patterns, each composed from the same
`@effect-uai/core` primitives: state, streams, turns, tools, and explicit
continuation.

Recipes are not published packages. They are type-checked, runnable examples
that double as living regression tests for the primitive surface.

## Available recipes

- [`basic-usage/`](./basic-usage/) - the core harness: state, stream, tools,
  and continuation.
- [`structured-output/`](./structured-output/) - one schema as provider
  contract and local validator.
- [`tool-call-approval/`](./tool-call-approval/) - gate sensitive calls before
  `executeAll`; still return one result per model-requested tool call.
- [`streaming-tool-output/`](./streaming-tool-output/) - show inner tool work
  to the user while returning one clean output to the model.
- [`streaming-structured-output/`](./streaming-structured-output/) - decode
  prompted JSONL one object at a time.
- [`multi-model-fallback/`](./multi-model-fallback/) - recover from provider
  stream failures by advancing to the next tier.
- [`auto-compaction/`](./auto-compaction/) - summarize history when token /
  turn budget is exceeded.
- [`pause-resume/`](./pause-resume/) - pause between loop iterations with a
  latch; no provider call remains open.
- [`mid-stream-abort/`](./mid-stream-abort/) - cancel the loop and the
  upstream HTTP request via scope-based cleanup.
- [`agentic-loop/`](./agentic-loop/) - drive a long-lived chat from a user
  message queue while continuing model/tool work between clean turn boundaries.
- [`modify-output-stream/`](./modify-output-stream/) - keep the loop
  transport-agnostic; project typed turn events into SSE or JSONL at the edge.
- [`model-retry/`](./model-retry/) - add retry policy around one model stream;
  only transient provider failures get another try.
- [`multi-model-compare/`](./multi-model-compare/) - fan one prompt out to
  multiple providers and isolate per-member failures.
- [`model-council/`](./model-council/) - stream candidate answers, judge them
  cross-model, and emit a winner.

Each recipe folder contains its own `README.md` describing the scenario.
Implementations live in `index.ts`; tests in `index.test.ts`.
