# @betalyra/effect-uai

_/ˈi.fɛkt ˈwaj/ — "effect-why"_

> **_Uai_** \\ wai \\ — Mineiro Portuguese, all-purpose interjection.

A small, explicit AI/LLM toolkit for Effect v4. PoC stage.

The library ships **typed building blocks**, not a framework. The "loop" between
model generations and your code is `Stream.paginate` written in your own file —
not a `streamText`/`runAgent` helper. Tool repair, model swaps, retries, HITL,
budget limits etc. are compositions of plain Effect operators on those
primitives, not new APIs.

## Design decisions

- **Loop is explicit, not hidden.** Multi-turn control is `Stream.paginate` in
  user code. No `Agent.run` / `streamText` / `stopWhen` / `prepareStep` /
  `experimental_repairToolCall`. The library never owns a loop you can't
  inspect.
- **Reuse Effect, don't reinvent.** Retries → `Schedule`. Error handling →
  `Effect.catchTag`. Model swap → `Effect.provideService`. Concurrency →
  `Effect.forEach`. Cancellation → `Fiber.interrupt`. Timing → `TestClock`. The
  job is to expose primitives at the right shape so these compose cleanly,
  not to wrap them.
- **State is the user's, fully polymorphic.** Whatever you put in `Stream.paginate`'s
  state — `history`, `model`, `budget`, `retries`, anything — is yours. The
  library has no opinion on state shape.
- **Streaming is the primitive, non-streaming is derived.** Providers implement
  one method: `streamTurn(history): Stream<TurnDelta>`, terminating in a
  `turn_complete` event. The `turn(history): Effect<Turn>` helper just drains
  it. No two parallel APIs to keep in sync.
- **Single-turn is provider-mechanical, multi-turn is user-policy.** The
  library owns "produce one assistant message including tool-call deltas"
  because that's wire-level. It does not own "should we continue?" because
  that's application logic.
- **Items mirror OpenAI Responses API.** `message` / `function_call` /
  `function_call_output` items with `input_text` / `output_text` content
  blocks. No invented intermediate `Message` type that has to be converted
  back and forth — the source of message-format bugs in other SDKs.
- **Validation lives at provider boundaries.** Reasoning-block invariants,
  cache-control rules, etc. are enforced where they matter (the provider
  before sending), not encoded as Schema invariants the loop has to honor.
- **Typed errors via `TaggedErrorClass`.** `AiError`, `ToolError` are
  discriminable with `Effect.catchTag`. The error surface is part of the
  contract.
- **Models are values, swapped per call.** `LanguageModel` is a `Context.Service`
  but its implementation is a plain value. To swap models mid-stream, carry
  the model in your state and `Effect.provideService(LanguageModel, state.model)`
  per iteration. No special API.
- **Recipes over helpers.** Common patterns (tool repair, model swap, HITL
  approval, budget limits, branch/replay) are published as small code snippets
  you copy into your own code, in the spirit of shadcn — not as exported
  combinators that turn into a tower of abstractions.
- **Bring your own tokenizer.** `Metrics.withRate(weight)` takes a weight
  function; whatever counts your tokens (`tiktoken`, huggingface.js, regex)
  plugs in there. The library never bundles a tokenizer.
- **Metrics are stream operators.** `withElapsed`, `timeToFirst`, `withRate`
  are generic over any `Stream<A>`. ttft, tok/s, parse-error rate, tool-call
  count — all are compositions; no telemetry framework, no callbacks.

## Status

PoC. Six tests pass: happy-path round-trip via `Stream.paginate`, model swap
via `Effect.provideService`, tool repair via `Effect.catchTag`, streaming
delta primitive, ttft + tok/s with `TestClock`-paced deltas.

```bash
pnpm test       # vitest run
pnpm typecheck  # tsc
```
