---
title: TypeSafe AI
description: "Jev, TypeSafe AI's System One model: typed classify, rate and probability questions answered in one call, with a per-answer confidence on the typed tag."
source: packages/providers/typesafe-ai
---

TypeSafe AI's Jev answers questions instead of generating text. Ask it
several typed questions about one input and it returns a probability
distribution for each, in one call, at a fraction of the cost and latency of
a language model turn. It is the first provider behind
[`DecisionModel`](/decisions/).

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

`jevLayer` registers two service tags from one implementation:

- **`Jev`**: the typed tag. Yield this for the model id union and for Jev's
  own `confidence` on each answer.
- **`DecisionModel`**: the generic tag for provider-portable code.

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
})
```

All three kinds are supported. Every decision in a definition goes out in
one request and the encoded input is billed once, so batch questions rather
than calling per question.

## Request shape

```ts
interface JevDecideRequest<A> extends Omit<CommonDecideRequest<A>, "model"> {
  readonly model: JevModel
}

type JevModel = "jev-latest" | "jev-preview" | "jev-1.13.0" | (string & {})
```

The `(string & {})` tail accepts any string so a newly released version
works without an SDK update.

## Models

| Model         | Notes                                |
| ------------- | ------------------------------------ |
| `jev-latest`  | Default. Tracks the current release. |
| `jev-preview` | Currently identical to `jev-latest`. |
| `jev-1.13.0`  | Pinned.                              |

64k tokens per request, of which roughly 32k for the encoded input plus the
longest single decision. Text only.

Reference: [TypeSafe AI docs](https://docs.typesafe.ai/introduction).

## Jev's own confidence

Yield the `Jev` tag and every `classify` and `rate` answer carries a
`confidence` field alongside the distribution. It is not on the generic
answer because its formula is undocumented and `probability` answers do not
have one.

```ts
import { Jev } from "@effect-uai/typesafe-ai/Jev"

const program = Effect.gen(function* () {
  const jev = yield* Jev
  const { answers } = yield* jev.decide(triage, { model: "jev-latest", input })
  answers.department.confidence // Jev's number
  Decision.margin(answers.department) // ours, same formula on every provider
})
```

For gating, prefer `Decision.margin` and the top probability. They are
documented, length-stable, and identical whichever provider you swap in.
See [gate on the right number](/decisions/#gate-on-the-right-number).

## About the scores

Probabilities sum to 1 within floating-point error and are comparable within
one answer. Two of three sample tickets in the [triage recipe](/recipes/decision-triage/)
came back with one label at exactly 1.00, so expect saturation at the top of
the range. Repeat runs on identical input move in the second decimal.

Known weak spots per the vendor's own notes: counting and arithmetic, date
ordering, and multi-hop reasoning. Rubric scores are weakly calibrated, so
read `Decision.expectedLevel` as a summary rather than a magnitude. Input is
not treated as hostile: an instruction injected into the input can steer an
answer, which is one more reason to project the input through a narrow
schema.

## Errors

HTTP failures map to typed `AiError` variants:

| Status      | Error                               |
| ----------- | ----------------------------------- |
| `401`       | `AiError.AuthFailed` (`auth`)       |
| `402`       | `AiError.AuthFailed` (`billing`)    |
| `403`       | `AiError.AuthFailed` (`permission`) |
| `408`/`504` | `AiError.Timeout`                   |
| `413`       | `AiError.ContextLengthExceeded`     |
| `429`       | `AiError.RateLimited`               |
| `>= 500`    | `AiError.Unavailable`               |
| other 4xx   | `AiError.InvalidRequest`            |

An input the schema cannot encode is `AiError.InvalidRequest` with
`param: "input"`. An answer whose shape does not match the decision that
asked for it is `AiError.GenerationFailed`.

## See also

- [Decision models](/decisions/): the cross-provider concept and how to read
  an answer.
- [Decision triage](/recipes/decision-triage/): five questions on a support
  ticket, routed in code.
