---
title: Multi-model compare
description: Fan a single prompt out to OpenAI, Google, and Anthropic concurrently and stream their tagged answers as they arrive.
---

Multi-model comparison is stream fan-out.

You want a side-by-side answer from multiple models for the same prompt - to
compare reasoning quality, audit verdicts, or ensemble. Each provider's deltas
should arrive concurrently and be tagged with which model produced them, and a
failure in one provider shouldn't kill the others.

This is the simplest fan-out shape: three `LanguageModelService`
instances, one shared history, `Stream.mergeAll` to interleave their
tagged outputs.

**Want a winner picked for you?** The
[model council](/recipes/model-council/) recipe extends this fan-out
with cross-evaluation: each model scores the _others'_ answers (no
self-judging), and the highest-rated answer is streamed as the
winner.

## What it shows

- Building three providers from the three packages
  ([`@effect-uai/responses`](/providers/responses/),
  [`@effect-uai/google`](/providers/gemini/),
  [`@effect-uai/anthropic`](/providers/anthropic/)) and
  treating them uniformly as `LanguageModelService` values.
- Wrapping each in a small `memberStream` that tags every delta with
  the member's name.
- Per-member error isolation via `Stream.catch` - a failure surfaces
  as an `error` event on the merged stream, not as a stream
  termination.
- Concurrency via `Stream.mergeAll(streams, { concurrency })` - all
  members start in parallel; their deltas interleave naturally.

## The pattern

The library bit lives in
[`council.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/multi-model-compare/council.ts):

```ts
export type CouncilEvent =
  | { readonly type: "delta"; readonly member: string; readonly delta: TurnDelta }
  | { readonly type: "error"; readonly member: string; readonly error: AiError }

const memberStream = (member: Member, history: ReadonlyArray<Item>): Stream.Stream<CouncilEvent> =>
  member.service.streamTurn({ history, model: member.model }).pipe(
    Stream.map((delta): CouncilEvent => ({ type: "delta", member: member.name, delta })),
    Stream.catch((error) =>
      Stream.succeed<CouncilEvent>({ type: "error", member: member.name, error }),
    ),
  )

export const council = (
  members: ReadonlyArray<Member>,
  history: ReadonlyArray<Item>,
): Stream.Stream<CouncilEvent> =>
  Stream.mergeAll(
    members.map((m) => memberStream(m, history)),
    { concurrency: members.length },
  )
```

The runner builds the three providers and consumes the merged stream:

```ts
const openai = yield* makeResponses({ apiKey: openaiKey })
const google = yield* makeGemini({ apiKey: googleKey })
const anthropic = yield* makeAnthropic({ apiKey: anthropicKey, defaultMaxTokens: 256 })

const members = [
  { name: "openai/gpt-5.4-mini", model: "gpt-5.4-mini", service: openai },
  { name: "google/gemini-3-flash-preview", model: "gemini-3-flash-preview", service: google },
  { name: "anthropic/claude-sonnet-4-6", model: "claude-sonnet-4-6", service: anthropic },
]

yield* Stream.runForEach(council(members, history), (event) =>
  /* match on event.type and log the delta or verdict */,
)
```

## Why per-member error isolation matters

Without `Stream.catch`, a single provider's `RateLimited` or
`Unavailable` would terminate the merged stream and lose the answers
the other two had already produced. The error wrapper turns failures
into ordinary stream values, so the council always emits one event
per member - either a `turn_complete` or an `error`.

If you want strict consensus (cancel everyone the moment one fails),
drop the `Stream.catch` and let the failure propagate out of
`Stream.mergeAll` - it will interrupt the sibling streams.

## Common-model parity check

Running the same prompt through all three providers is also the
fastest way to verify the common
[`LanguageModelService`](/concepts/loop/#streamuntilcomplete)
abstraction holds: same history shape in, same `TurnDelta` stream
out, same `Turn` shape on completion. The token accounting carries
the cached-tokens / reasoning-tokens detail across providers
identically.

## Run it

```sh
OPENAI_API_KEY=sk-... GOOGLE_API_KEY=... ANTHROPIC_API_KEY=... \
  pnpm tsx recipes/multi-model-compare/index.ts
```

You'll see one verdict log per member as each completes - in whatever
order they finish - with the assistant text, stop reason, and usage
(including `cached_tokens` / `reasoning_tokens` where the provider
reports them).

The full source lives next to this README at
[`recipes/multi-model-compare/`](https://github.com/betalyra/effect-uai/tree/main/recipes/multi-model-compare).

## See also

- [Model council](/recipes/model-council/) - same fan-out, but the
  models cross-evaluate and the winner is streamed back.
