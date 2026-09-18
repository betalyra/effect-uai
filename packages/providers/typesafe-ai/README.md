# @effect-uai/typesafe-ai

TypeSafe AI provider for [`@effect-uai/core`](https://github.com/betalyra/effect-uai/tree/main/packages/core).
Serves the `DecisionModel` capability with Jev, a System One model that
answers typed questions about an input with probabilities instead of
generating text.

> Experimental. This class of model is new and the shape may change.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/typesafe-ai effect
```

## Wire it up

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as jevLayer } from "@effect-uai/typesafe-ai/Jev"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("TYPESAFE_AI_API_KEY")
    return jevLayer({ apiKey })
  }),
)

const mainLayer = provider.pipe(Layer.provide(FetchHttpClient.layer))
```

One layer, two tags: `Jev` for its own reported `confidence`, `DecisionModel`
for provider-portable code.

## Decide

```ts
import { Schema } from "effect"
import * as Decision from "@effect-uai/core/Decision"
import { decide } from "@effect-uai/core/DecisionModel"

const triage = Decision.make({
  inputSchema: Schema.Struct({ message: Schema.String }),
  decisions: {
    department: Decision.classify({
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Payments, invoicing, refunds",
        technical: "Bugs, outages, integrations",
      },
    }),
    severity: Decision.rate({
      instructions: "How severe is the reported issue?",
      criteria: ["Cosmetic", "Degraded", "Blocking"],
    }),
    urgent: Decision.probability({ instructions: "Does this convey urgency?" }),
  },
})

const program = Effect.gen(function* () {
  const { answers } = yield* decide(triage, {
    model: "jev-latest",
    input: { message: "Payouts have been failing for 3 days." },
  })

  answers.department.labels.billing // number
  answers.urgent.probability // number
  answers.severity.legend[Decision.topLevel(answers.severity)] // "Degraded"

  const leader = Decision.ranked(answers.department)[0]
  return leader === undefined || leader.probability < 0.5 ? "escalate" : leader.label
})
```

Every decision in a definition is answered in one call, and the encoded input
is billed once, so batch them rather than calling per question.

## Models

`jev-latest` (default), `jev-preview`, `jev-1.13.0`. 64k tokens per request,
of which roughly 32k for the encoded input plus the longest single decision.
Text only.

## What the input schema is for

`inputSchema` encodes the input on the way out. A schema that omits a field
keeps it from the model, which is the supported way to hold irrelevant or
sensitive context out of a request. The vendor documents large irrelevant
input as a distractor, so projecting deliberately is worth doing.

## About the scores

Probabilities sum to 1 within floating-point error and are comparable within
one answer. Jev's own `confidence` is available on the `Jev` tag; it is not on
the common answer because its formula is undocumented and it is absent on
`probability` decisions. `Decision.confidence` and `Decision.margin` are
computed from the distribution, documented, and defined for every kind. Gate
on the top probability and `margin`, not on `confidence`: normalised entropy
shrinks as the label count grows, so a threshold tuned on two labels quietly
demands far more mass on four.

Known weak spots per the vendor's own jaggedness notes: counting and
arithmetic, date ordering, multi-hop reasoning, and rubric scores are weakly
calibrated so `expectedLevel` should not be read back as a magnitude. Input is
not treated as hostile, so an injected instruction in the input can steer an
answer.

## Errors

| Status    | `AiError`                          |
| --------- | ---------------------------------- |
| 401       | `AuthFailed{subtype:"auth"}`       |
| 402       | `AuthFailed{subtype:"billing"}`    |
| 403       | `AuthFailed{subtype:"permission"}` |
| 408 / 504 | `Timeout`                          |
| 413       | `ContextLengthExceeded`            |
| 422       | `InvalidRequest`                   |
| 429       | `RateLimited`                      |
| 5xx       | `Unavailable`                      |

An input the schema cannot encode is `InvalidRequest` with `param: "input"`.
An answer whose shape does not match the decision that asked for it is
`GenerationFailed`.

## See also

- [Decision models](https://effect-uai.betalyra.com/decisions/)
- [TypeSafe AI usage page](https://effect-uai.betalyra.com/decisions/providers/typesafe-ai/)
- [`@effect-uai/core/Decision`](https://github.com/betalyra/effect-uai/tree/main/packages/core/src/decision-model)
