---
name: effect-uai-model-escalation
description: Use when the user wants cost-aware model routing with effect-uai — start on a fast cheap model and let it escalate hard questions to a stronger model via a tool call. Covers the escalate(reason, question) descriptor, prompt-level escalation policy, onTurnComplete interception, tier_active/escalated events, and the difference from provider-failure fallback.
license: MIT
---

# effect-uai model-escalation

Start cheap, escalate only when the model decides the question needs a
stronger tier.

Reach for this when the user says any of:

- "Use a cheap model for easy questions and a strong model for hard ones"
- "Let the model decide when to escalate"
- "Route by question difficulty, not provider failure"

## The control tool

Give the cheap tier an `escalate` tool descriptor:

```ts
export const EscalateInput = Schema.Struct({
  reason: Schema.String,
  question: Schema.String,
})

export const escalate = Tool.make({
  name: "escalate",
  description:
    "Hand the question off to a stronger, more expensive model. Use when the question requires deep expertise that a fast model can't deliver with high confidence.",
  inputSchema: Tool.fromEffectSchema(EscalateInput),
  run: () => Effect.succeed({ escalated: true }),
  strict: true,
})
```

`run` is not the point. The loop intercepts the call at
`onTurnComplete` and turns it into a tier transition.

## Loop shape

```ts
const deltas = tier.service
  .streamTurn({
    history: requestHistory,
    model: tier.model,
    ...(current.tier === 0 ? { tools: escalateDescriptors } : {}),
  })
  .pipe(
    onTurnComplete<State, EscalationEvent>((turn) =>
      Effect.sync(() => {
        if (current.tier === 1) return stop

        const call = Turn.functionCalls(turn).find((c) => c.name === "escalate")
        if (call === undefined) return stop

        return Result.match(decodeEscalateArgs(call.arguments), {
          onFailure: () => stop,
          onSuccess: (args) =>
            nextAfter(
              Stream.succeed<EscalationEvent>({ _tag: "escalated", ...args }),
              { history: current.history, tier: 1, escalation: args },
            ),
        })
      }),
    ),
  )
```

Only tier 0 sees the tool. Tier 1 has no `escalate` descriptor and is
terminal.

## Policy

The escalation policy belongs in the cheap tier's system prompt. Use it
to define what the cheap model may answer directly and what it must
escalate: regulated domains, hard reasoning, expert topics, security,
architecture, or anything where you would rather spend for quality.

The strong tier should not see the cheap tier's system prompt, cheap
turn, or function call. It should see the accumulated user
conversation, then produce the final answer.

## Events

Emit custom events alongside provider deltas:

- `tier_active` tells the UI which tier/model is speaking.
- `escalated` carries the model's `reason` and self-contained
  `question` for logs, analytics, or display.

## Anti-patterns

- **Don't use this for provider outages.** Use
  `effect-uai-multi-model-fallback` for `RateLimited`, `Unavailable`,
  and other retryable provider failures.
- **Don't execute `escalate` as a normal tool.** It is a loop control
  signal, not a userland side effect.
- **Don't append the cheap-tier tool call to strong-tier history.** The
  strong model does not need a tool it cannot see.

## See also

- Recipe source: `recipes/model-escalation/index.ts`
- For provider failure fallback: `effect-uai-multi-model-fallback`
- For side-by-side model output: `effect-uai-multi-model-compare`
