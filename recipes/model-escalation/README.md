---
title: Model escalation
description: Route easy questions to a fast cheap model; let the model itself escalate hard questions to a stronger one via a tool call.
source: recipes/model-escalation
icon: PiStairsBold
---

Most questions don't need your strongest model. But you usually don't
know which ones do until a model has looked at the prompt.

This recipe starts on a fast, cheap tier and gives that tier one extra
tool: `escalate(reason, question)`. The system prompt defines the
policy. Easy questions get answered immediately. Hard questions become
a tool call, and the loop advances to a stronger tier.

This is not failover. [`multi-model-fallback`](../multi-model-fallback)
advances tiers on provider failure (`RateLimited`, `Unavailable`). Here
the model itself opts to escalate based on the question.

**Scenario.** Use a cheap model for trivia, simple lookups, and small
talk. Let it escalate quantum physics, legal advice, architecture
reviews, or anything else you would rather not trust to the cheap tier.

## The Move

- **The policy is prompt-level.** Change `CHEAP_TIER_SYSTEM_PROMPT` to
  decide what counts as "too hard".
- **The escalation tool is a control signal.** The cheap model sees the
  descriptor, but the recipe intercepts the call at `onTurnComplete`
  instead of executing it as a normal tool.
- **The handoff is clean.** The strong tier sees the accumulated user
  conversation, but not the cheap tier's system prompt, cheap-tier
  answer, or `escalate` function call.
- **The transition is observable.** `tier_active` and `escalated`
  events stream next to provider deltas so a UI can show which tier is
  talking and why it switched.

## The Shape

```ts
export const conversation = (cheap: Tier, strong: Tier) => (state: State) =>
  pipe(
    state,
    loop((current) =>
      Effect.gen(function* () {
        const tier = current.tier === 0 ? cheap : strong

        const announce = Stream.succeed(
          value<EscalationEvent>({ _tag: "tier_active", tier: ..., model: tier.model }),
        )

        const deltas = tier.service
          .streamTurn({
            history: current.history,
            model: tier.model,
            // Only the cheap tier gets the escalate tool.
            ...(current.tier === 0 ? { tools: escalateDescriptors } : {}),
          })
          .pipe(
            // `then` may return a step stream directly or an Effect of one -
            // bare `stop` for the guards, an Effect for the decode branch.
            onTurnComplete<State, EscalationEvent>((turn) => {
              if (current.tier === 1) return stop
              const call = Turn.functionCalls(turn).find((c) => c.name === "escalate")
              if (call === undefined) return stop

              // Decode against escalate's own schema - the tool already owns
              // it, so there's no second decoder to keep in sync.
              return Tool.decodeArgs(escalate, call).pipe(
                Effect.map((args) =>
                  nextAfter(Stream.succeed<EscalationEvent>({ _tag: "escalated", ...args }), {
                    history: current.history,
                    tier: 1,
                    escalation: args,
                  }),
                ),
                Effect.catch(() => Effect.succeed(stop)),
              )
            }),
          )

        return Stream.concat(announce, deltas)
      }),
    ),
  )
```

The strong tier is terminal: no `escalate` tool, `onTurnComplete` always
returns `stop`. One strong-tier turn answers, the loop ends.

The `question` argument is still useful even though the strong tier gets
`current.history`: it gives the UI a clean, self-contained reason for
the transition and is handy for logs or analytics.

## What This Generalizes To

Use this when quality routing depends on the content of the question,
not provider health. It is useful for:

- cost-aware chat, where cheap models handle routine turns;
- domain escalation, where a policy sends regulated or expert topics to
  a stronger model;
- user-visible model switching, where the UI should explain why a
  stronger tier took over.

If the problem is provider failure, use
[`multi-model-fallback`](../multi-model-fallback) instead. If the
problem is comparing answers from multiple models, use
[`multi-model-compare`](../multi-model-compare).

## Run it

The runner is an interactive chat - type a question, watch which tier
answers.

```sh
pnpm tsx recipes/model-escalation/run-node.ts --provider openai     # OPENAI_API_KEY=sk-...
pnpm tsx recipes/model-escalation/run-node.ts --provider google     # GOOGLE_API_KEY=...
pnpm tsx recipes/model-escalation/run-node.ts --provider anthropic  # ANTHROPIC_API_KEY=sk-...
```

Default is `--provider openai`. Cheap / strong pairs:

| Provider  | Cheap                    | Strong                   |
| --------- | ------------------------ | ------------------------ |
| openai    | `gpt-5.4-mini`           | `gpt-5.4`                |
| google    | `gemini-3-flash-preview` | `gemini-3.1-pro-preview` |
| anthropic | `claude-haiku-4-5`       | `claude-sonnet-4-6`      |

Try one easy question and one hard one in the same session:

```
you> What's the capital of Portugal?
[cheap: gemini-3-flash-preview] Lisbon.

you> Why does a quantum harmonic oscillator have non-zero ground-state energy?
[cheap: gemini-3-flash-preview]
  ↳ escalating (advanced quantum mechanics requires deeper expertise)
[strong: gemini-3.1-pro-preview] Because of the Heisenberg uncertainty principle...
```

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/model-escalation/index.ts)
and [`run-node.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/model-escalation/run-node.ts).
