---
title: Decision triage
description: Route, prioritise and flag an inbound support ticket with five typed questions in one call, then decide in code how sure you need to be.
source: recipes/decision-triage
icon: PiSignpost
---

A ticket arrives. Which team gets it? How bad is it? Is it urgent? Are they
asking for money back? Will a human need to redact it first?

You could ask a language model, parse the prose, and pay for a full
generation five times. Or you ask a decision model once and get back a
probability for every answer, so the routing rule lives in your code and you
can see how sure the model was before you act on it.

## Run it

```sh
TYPESAFE_AI_API_KEY=... pnpm tsx recipes/decision-triage/run.ts
```

```sh
# your own tickets, no rebuild
... run.ts --tickets recipes/decision-triage/tickets.json

# pin a version
... run.ts --model typesafe:jev-1.13.0
```

## Ask all five at once

Declare the questions once. The ticket is the only thing that changes per
call.

```ts
export const triage = Decision.make({
  inputSchema: Ticket,
  decisions: {
    department: Decision.classify({
      instructions: "Which team should handle this ticket?",
      criteria: { billing, technical, account, other },
    }),
    severity: Decision.rate({
      instructions: "How severe is the problem?",
      criteria: [cosmetic, degraded, blocked, losingMoney],
    }),
    urgent: Decision.probability({ instructions: "Does the customer say this is time-sensitive?" }),
    refund: Decision.probability({ instructions: "Is the customer asking for a refund?" }),
    personalData: Decision.probability({ instructions: "Does the message contain personal data?" }),
  },
})
```

One call answers all five, and the ticket is billed once. That is why
`personalData` is there: you only need it if a human ends up reading the
ticket, and asking now costs a few tokens where asking later costs a round
trip.

## Read the answer

```ts
Effect.gen(function* () {
  const { answers } = yield* decide(triage, { model, input: ticket })

  answers.department.labels.billing // 0.13
  answers.urgent.probability // 0.94
  answers.severity.legend[Decision.topLevel(answers.severity)] // "A workflow is blocked..."
})
```

Label names are typed. `answers.department.labels.shipping` is a compile
error, not a runtime `undefined`.

| You want                         | Call                                           |
| -------------------------------- | ---------------------------------------------- |
| the most likely label            | `Decision.winner`                              |
| all labels, best first           | `Decision.ranked`                              |
| how far ahead the leader is      | `Decision.margin`                              |
| how decided the whole answer is  | `Decision.confidence`                          |
| the rubric level, or its average | `Decision.topLevel` / `Decision.expectedLevel` |

## Decide how sure is sure enough

Two kinds of doubt need opposite handling. A close runner-up means one
clarifying question will settle it. A flat spread means nothing will, so a
person should look.

```ts
const ranked = Decision.ranked(department)
const leader = ranked[0]

if (leader === undefined || leader.probability < 0.5)
  return { kind: "human", reason: "no clear department" }
if (Decision.margin(department) < 0.15) return { kind: "clarify", between: ranked.slice(0, 2) }
if (refund.probability > 0.7) return { kind: "human", reason: "refund requested" }
return { kind: "auto", queue: leader.label, priority }
```

The gates read the top probability and the margin, not `Decision.confidence`.
Confidence is normalised entropy, and entropy depends on how many labels you
offered. On the third sample ticket:

```
department  account 0.74   billing 0.13   other 0.13   technical 0.00
certainty   confidence 0.46   margin 0.61
```

That is a clear answer, and confidence still calls it 0.46, because a quarter
of the mass is spread over two other labels out of four. A threshold that
looks right on a yes/no question will quietly escalate most four-way ones.
Top probability and margin mean the same thing whatever the label count.

## Leave headroom

The thresholds are examples. Fit them on your own tickets. Two things to know
before you do:

- **Answers drift a little between runs** on the same input, in the second
  decimal. Do not tune a threshold to three.
- **Probabilities compare within one answer**, not across models. No provider
  promises a threshold carries over when you swap.

The vendor's own numbers on this pattern are worth knowing: on a 75-way
classification, answers above confidence 0.9 were right 90% of the time and
those below it 40%. Falling back to a coarser label below the line turned
that 40% into 70%.

## The schema is your filter

`Ticket` validates a `--tickets` file and encodes each ticket onto the wire.
A malformed file fails before anything is billed. A field the schema does not
mention never reaches the model, which is how you keep an internal note or a
customer id out of the request.

## See also

- [Decision models](/decisions/)
- [TypeSafe AI](/decisions/providers/typesafe-ai/)
- [Model escalation](/recipes/model-escalation/), which retries upward after a
  failure rather than routing before spending
