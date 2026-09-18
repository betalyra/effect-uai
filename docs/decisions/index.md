---
title: Decision models
description: Ask typed questions about an input and get a probability for every answer, all in one call. One generic service tag, swappable providers.
icon: PiScales
---

Your agent has a message in hand and needs to know a few things about it
before it acts. Which queue? How severe? Is this a refund request? A
language model can tell you, in prose, for the price of a generation per
question.

`DecisionModel` answers those questions directly. You declare what you want
to know and what the possible answers are, hand it the input, and get back a
probability distribution per question. All questions are answered in one
call against one input, and the input is billed once, so asking a sixth
question costs a few tokens rather than another round trip.

The routing rule stays in your code. The model reports beliefs; you decide
what is sure enough.

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

One layer, two tags: `Jev` for the provider's own extras, `DecisionModel`
for provider-portable code.

## Three kinds of question

```ts
import { Schema } from "effect"
import * as Decision from "@effect-uai/core/Decision"

const triage = Decision.make({
  inputSchema: Schema.Struct({ subject: Schema.String, body: Schema.String }),
  decisions: {
    department: Decision.classify({
      instructions: "Which team should handle this ticket?",
      criteria: {
        billing: "Charges, invoices, refunds, payment failures",
        technical: "Bugs, outages, integrations, API errors",
        account: "Login, permissions, seats, plan changes",
      },
    }),
    severity: Decision.rate({
      instructions: "How severe is the problem for the customer?",
      criteria: ["Cosmetic", "Degraded, workaround exists", "Blocked", "Losing money now"],
    }),
    refund: Decision.probability({ instructions: "Is the customer asking for a refund?" }),
  },
})
```

- **`classify`** picks one of a set of named labels. Each label carries a
  description the model reads.
- **`rate`** places the input on an ordered rubric, lowest level first. Use
  it when the options form a spectrum rather than a set.
- **`probability`** asks how likely one statement is to hold. Optional
  `criteria: { true, false }` spell out where the boundary is when it is
  subtle.

Declare the definition once at module scope. The questions and their rubrics
are the thing you review; the input changes per call.

## Decide

```ts
import { decide } from "@effect-uai/core/DecisionModel"

const program = Effect.gen(function* () {
  const { answers, usage } = yield* decide(triage, {
    model: "jev-latest",
    input: {
      subject: "Charged twice",
      body: "Two identical charges on the 3rd, please refund one.",
    },
  })

  answers.department.labels.billing // 0.91
  answers.severity.levels // [0.05, 0.6, 0.3, 0.05], aligned with the rubric
  answers.severity.legend[1] // "Degraded, workaround exists"
  answers.refund.probability // 0.97
})
```

Answers come back keyed by decision name and typed by what you asked.
`answers.department.labels.shipping` is a compile error. A `rate` answer's
`levels` is a tuple the length of your rubric, with the rubric echoed as
`legend` so an index reads back as prose.

## Reading an answer

Every answer is a distribution. These read it the same way whichever
provider you wired:

| Function                 | Gives you                                                         |
| ------------------------ | ----------------------------------------------------------------- |
| `Decision.winner`        | the highest-probability label, `None` only for an empty label set |
| `Decision.ranked`        | labels best first, which is also what `Rank.rrf` takes            |
| `Decision.margin`        | top probability minus the runner-up                               |
| `Decision.confidence`    | 1 minus normalised entropy: 1 is decided, 0 is flat               |
| `Decision.topLevel`      | index of the most likely rubric level, ties to the lowest         |
| `Decision.expectedLevel` | probability-weighted mean of the level indices                    |

`confidence` and `margin` are defined for every kind. A `probability`
answer's implied distribution is `[p, 1 - p]`.

## Gate on the right number

Two kinds of doubt need opposite handling, and telling them apart takes two
numbers. A close runner-up is resolvable with one more question. A flat
spread is not, so escalate.

```ts
const leader = Decision.ranked(answers.department)[0]

if (leader === undefined || leader.probability < 0.5) return escalate
if (Decision.margin(answers.department) < 0.15) return clarify
return leader.label
```

**Do not gate on `Decision.confidence`.** Normalised entropy depends on how
many labels you offered: a decisive `0.74 / 0.13 / 0.13 / 0.00` scores only
0.46 on four labels, so a threshold that looks right on a yes/no question
silently escalates most four-way ones. Top probability and margin mean the
same thing at any label count. Confidence is worth printing, and worth using
when the shape of the whole distribution is the point, such as comparing two
runs of the same question set.

Three more things the numbers do not promise:

- **Calibration is per provider.** Probabilities sum to 1 and are comparable
  within one answer. Whether a stated 0.8 is right 80% of the time is
  documented on the provider's page, never assumed by the generic tag.
- **Thresholds do not transfer.** A cutoff fitted on one model is not a cutoff
  on another. Refit when you swap the Layer.
- **Answers drift a little between runs** on identical input, in the second
  decimal. Leave headroom instead of tuning to three, and never depend on the
  order of tied labels.

## The schema is a filter

`inputSchema` encodes the input on the way out. A field the schema does not
mention never reaches the model, which is the supported way to hold an
internal note, a customer id, or a long irrelevant transcript out of the
request. Providers document large irrelevant input as a distractor, so
projecting deliberately is worth doing.

## What a decision model is not

- **Not a language model.** It returns no text. If you need a reason, a
  summary, or a reply, that is a [language model](/language-models/) turn.
- **Not a reranker.** A [reranker](/reranking/) scores candidates against a
  query with an uncalibrated ordinal score. A decision model answers a
  predicate you wrote, with a probability. The two do not substitute.
- **Not a classifier you train.** The labels and rubrics are the prompt. Change
  them and the next call uses the new ones.

## See also

- [Ticket triage](/recipes/ticket-triage/): five questions on a support
  ticket, then a routing rule that knows when to ask a human.
- [TypeSafe AI](/decisions/providers/typesafe-ai/): the provider, its models,
  and what its own confidence field adds.
- [Reranking](/reranking/): when you have candidates and a query, not a
  predicate.
