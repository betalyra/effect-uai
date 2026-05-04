---
name: effect-uai-multi-model-compare
description: Use when the user wants the same prompt sent to multiple providers concurrently and their tagged answers streamed side-by-side — e.g. compare reasoning quality, audit verdicts, ensemble. Per-member error isolation: a failure in one provider becomes one event, not a stream termination.
license: MIT
---

# effect-uai multi-model-compare

Send one prompt to multiple providers concurrently; stream their
tagged outputs as they arrive. Per-member errors become events on the
merged stream, not stream terminations.

Reach for this when the user says any of:

- "Compare answers from OpenAI, Gemini, and Anthropic side-by-side"
- "Run the same prompt through multiple models concurrently"
- "Ensemble multiple models for one question"

For a winner picked by cross-evaluation, see
`effect-uai-model-council` instead.

## Event taxonomy

```ts
import type { TurnEvent } from "@effect-uai/core/Turn"
import type * as AiError from "@effect-uai/core/AiError"

export type CompareEvent =
  | { readonly type: "delta"; readonly member: string; readonly delta: TurnEvent }
  | { readonly type: "error"; readonly member: string; readonly error: AiError.AiError }
```

## The pattern

```ts
import { Stream } from "effect"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import type * as Items from "@effect-uai/core/Items"

interface Member {
  readonly name: string
  readonly model: string
  readonly service: LanguageModelService
}

const memberStream = (
  member: Member,
  history: ReadonlyArray<Items.Item>,
): Stream.Stream<CompareEvent> =>
  member.service.streamTurn({ history, model: member.model }).pipe(
    Stream.map((delta): CompareEvent => ({ type: "delta", member: member.name, delta })),
    // Per-member error isolation - failures become events, not stream terminations.
    Stream.catch((error) =>
      Stream.succeed<CompareEvent>({ type: "error", member: member.name, error }),
    ),
  )

export const compare = (
  members: ReadonlyArray<Member>,
  history: ReadonlyArray<Items.Item>,
): Stream.Stream<CompareEvent> =>
  Stream.mergeAll(
    members.map((m) => memberStream(m, history)),
    { concurrency: members.length },
  )
```

## Wiring three providers

```ts
import { make as makeResponses } from "@effect-uai/responses"
import { make as makeGemini } from "@effect-uai/google"
import { make as makeAnthropic } from "@effect-uai/anthropic"

const program = Effect.gen(function* () {
  const openai = yield* makeResponses({ apiKey: openaiKey })
  const google = yield* makeGemini({ apiKey: googleKey })
  const anthropic = yield* makeAnthropic({ apiKey: anthropicKey, defaultMaxTokens: 256 })

  const members = [
    { name: "openai/gpt-5.4-mini", model: "gpt-5.4-mini", service: openai },
    { name: "google/gemini-2.5-flash", model: "gemini-2.5-flash", service: google },
    { name: "anthropic/claude-sonnet-4-6", model: "claude-sonnet-4-6", service: anthropic },
  ]

  yield* Stream.runForEach(compare(members, history), (event) =>
    /* match on event.type and log */,
  )
})
```

`make({ apiKey })` returns a `LanguageModelService` value (vs.
`layer({ apiKey })` which returns a Layer). Use `make` for
per-member service swapping; use `layer` for app-wide single-provider
wiring.

## Strict consensus vs. isolated failure

The recipe uses `Stream.catch` to convert per-member failures into
events so the comparison always emits one result per member. To
enforce strict consensus (cancel everyone if any one fails), drop
the `Stream.catch` and let the failure propagate out of
`Stream.mergeAll` — it will interrupt the sibling streams.

## Common-model parity check

Running the same prompt through all three providers is the fastest way
to verify that the common `LanguageModelService` abstraction holds:
same history shape in, same `TurnEvent` stream out, same `Turn` shape
on completion. Token accounting (`cached_tokens`, `reasoning_tokens`)
flows uniformly across providers.

## See also

- Recipe source: `recipes/multi-model-compare/`
- For voting / picking a winner: `effect-uai-model-council`
- For provider failover (try one, fall back to another): `effect-uai-multi-model-fallback`
