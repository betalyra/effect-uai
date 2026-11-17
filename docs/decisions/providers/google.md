---
title: Google Decisions
description: "Google's Decisions API through DecisionModel: classify, rate and probability questions in one call, input tokens billed only, a confidence on every answer."
source: packages/providers/google
---

Google's Decisions API answers typed questions about one input with
probabilities, in one forward pass. Only the input is billed; there are no
output tokens. It sits behind the generic [`DecisionModel`](/decisions/), so
code written against TypeSafe AI runs here unchanged.

> Experimental. This class of model is new and the shape may change.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/google effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { layer as decisionLayer } from "@effect-uai/google/GeminiDecisionModel"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.Redacted("GOOGLE_API_KEY")
    return decisionLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

One implementation, two tags:

- **`GeminiDecisionModel`**: the typed tag. Yield this for Google's own
  `confidence` on each answer.
- **`DecisionModel`**: the generic tag for provider-portable code.

## Decide

```ts
import { decide } from "@effect-uai/core/DecisionModel"

const program = Effect.gen(function* () {
  const { answers, usage } = yield* decide(triage, {
    model: "gemini-decision-1",
    input: { message: "Payouts have been failing for 3 days." },
  })
  answers.department.labels.billing // number
  usage.inputTokens // what you paid for
})
```

`triage` is any `Decision.make` definition; see
[Decision models](/decisions/). All three kinds are supported: `classify`,
`rate` and `probability`. A `probability` decision's `criteria` (`true` /
`false`) describe what each answer means.

The input is encoded with the definition's `inputSchema` and sent as text:
a string as written, anything else as its JSON.

## Google's own confidence

Every answer on the typed tag carries `confidence`, Google's estimate that
its top answer is right. It is not on the generic answer;
`Decision.margin` and the top probability are ours and mean the same on
every provider.

```ts
import { GeminiDecisionModel } from "@effect-uai/google/GeminiDecisionModel"

const program = Effect.gen(function* () {
  const model = yield* GeminiDecisionModel
  const { answers } = yield* model.decide(triage, { model: "gemini-decision-1", input })
  answers.urgent.confidence // Google's number
})
```

## Limits

Checked before the request goes out, so a bad definition fails
`InvalidRequest` naming every offending decision instead of costing a call:

- 1 to 1,000 decisions per request.
- Decision names are 1 to 64 characters of `A-Z a-z 0-9 _ -`.
- A `classify` has 2 to 255 labels, each 1 to 128 characters with no
  leading or trailing spaces.
- A `rate` has up to 255 levels.

The context is 262,144 tokens across the input and all questions.

## Errors

| Situation                           | Error                       |
| ----------------------------------- | --------------------------- |
| A safety filter blocked the input   | `ContentFiltered`, with why |
| A limit or name Google rejects      | `InvalidRequest`            |
| An answer missing or the wrong kind | `GenerationFailed`          |
| Rate limited                        | `RateLimited`               |
| Bad key                             | `AuthFailed`                |

## See it working

```sh
GOOGLE_API_KEY=... pnpm tsx recipes/ticket-triage/run.ts --model google:gemini-decision-1
```

Reference: [Decisions API](https://aistudio.google.com/docs/decisions-api).
