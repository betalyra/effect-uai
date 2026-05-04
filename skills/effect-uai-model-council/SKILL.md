---
name: effect-uai-model-council
description: Use when the user wants three (or more) models to answer the same question, score each other's answers (no self-judging), and emit a winner — e.g. consensus voting, audit, automated quality picking. Pure Stream composition; no Queue, no Deferred, no manual forks.
license: MIT
---

# effect-uai model-council

Three models answer the same question, each scores the *others'*
answers, and the highest-rated answer is streamed as the winner.
Everything flows through one `Stream<CouncilEvent>` — no `Queue`, no
`Deferred`, no manual forks. The dependency graph is implicit in
where `flatMap` runs.

Reach for this when the user says any of:

- "Vote across multiple models for the best answer"
- "Cross-evaluation between models"
- "Pick a winner among ensemble outputs"

For side-by-side without scoring, use `effect-uai-multi-model-compare`.

## Event taxonomy

```ts
export type CouncilEvent =
  | { type: "candidate_delta"; member: string; delta: TurnEvent }
  | { type: "candidate_complete"; member: string; answer: string }
  | { type: "score"; judge: string; subject: string; score: number; rationale: string }
  | { type: "winner"; member: string; answer: string; averageScore: number }
  | { type: "error"; member: string; phase: "generate" | "judge"; error: AiError.AiError }
```

A consumer that just wants the verdict can `runCollect` and find the
`winner` event. A consumer that wants live UX renders deltas, drops
in scores as they arrive, then highlights the winner.

## The shape, in three layers

**Per candidate** — accumulate text, emit deltas live, spawn judges
on `candidate_complete`:

```ts
import { Stream } from "effect"

const candidatePipeline = (member, judges, history) =>
  member.service.streamTurn({ history, model: member.model }).pipe(
    Stream.mapAccum(
      () => "",
      (acc, delta) => {
        if (delta.type === "text_delta")
          return [acc + delta.text, [{ type: "candidate_delta", member: member.name, delta }]]
        if (delta.type === "turn_complete")
          return [acc, [{ type: "candidate_complete", member: member.name, answer: acc }]]
        return [acc, [{ type: "candidate_delta", member: member.name, delta }]]
      },
    ),
    Stream.catch((error) =>
      Stream.succeed({ type: "error", member: member.name, phase: "generate", error }),
    ),
    // Spawn judges when a candidate finishes - no judge waits on its own answer.
    Stream.flatMap((event) => {
      if (event.type !== "candidate_complete") return Stream.succeed(event)
      const others = judges.filter((j) => j.name !== member.name)
      return Stream.merge(
        Stream.succeed(event),
        Stream.mergeAll(
          others.map((j) => judgeStream(j, member.name, event.answer, history)),
          { concurrency: "unbounded" },
        ),
      )
    }),
  )
```

**Per judge** — accumulate the JSON, decode with a schema, emit one
`score` event:

```ts
import { Result, Schema } from "effect"

const ScoreSchema = Schema.Struct({
  score: Schema.Number,
  rationale: Schema.optional(Schema.String),
})
const decodeScore = Schema.decodeResult(Schema.fromJsonString(ScoreSchema))

const judgeStream = (judge, subject, subjectAnswer, history) =>
  judge.service
    .streamTurn({ history: judgeHistory(history, subject, subjectAnswer), model: judge.model })
    .pipe(
      Stream.mapAccum(
        () => "",
        (acc, delta) => {
          if (delta.type === "text_delta") return [acc + delta.text, []]
          if (delta.type !== "turn_complete") return [acc, []]
          return Result.match(decodeScore(acc.trim()), {
            onSuccess: (s) => [acc, [{ type: "score", judge: judge.name, subject, ...s }]],
            onFailure: (issue) => [
              acc,
              [{ type: "error", member: judge.name, phase: "judge", error: invalidRequest(issue) }],
            ],
          })
        },
      ),
    )
```

**Top level** — merge candidates, tally scores, emit winner on halt:

```ts
export const council = (members, history) =>
  Stream.mergeAll(
    members.map((m) => candidatePipeline(m, members, history)),
    { concurrency: members.length },
  ).pipe(
    Stream.mapAccum(
      () => emptyTally,
      (tally, event) => {
        if (event.type === "candidate_complete")
          return [recordCandidate(tally, event.member, event.answer), [event]]
        if (event.type === "score")
          return [recordScore(tally, event.subject, event.score), [event]]
        return [tally, [event]]
      },
      {
        onHalt: (tally) => {
          const w = pickWinner(tally)
          return w === null
            ? []
            : [{ type: "winner", member: w.member, answer: w.answer, averageScore: w.averageScore }]
        },
      },
    ),
  )
```

`onHalt` is the key bit for the winner: instead of tracking how many
scores are "expected" (which gets tricky when a candidate fails and no
one judges it), we wait until upstream halts and pick the best from
whatever scores landed.

## Per-phase error isolation

If one model returns malformed JSON, don't:
- silently score zero (would unfairly penalize the subject), or
- take the whole council down.

Schema decode failures become typed `AiError.InvalidRequest` events
with `phase: "judge"`. The rest of the scores still land; the tally
averages over what arrived; the winner is still emitted. Same for
transport failures (`RateLimited`, `Unavailable`, etc.) — `Stream.catch`
turns them into `error` events of the right phase.

## Caveats

- **Self-bias.** Even with the no-self-judging rule, models tend to
  prefer answers that match their own style. Read the scores, not
  just the winner.
- **JSON discipline.** A judge model that ignores the "JSON only"
  instruction produces a parse failure for that judge call — handled
  gracefully but the affected subject loses one vote.
- **Cost.** N candidates + N(N-1) judge calls. Use cheap-tier models
  for production fan-out.

## See also

- Recipe source: `recipes/model-council/`
- For side-by-side without scoring: `effect-uai-multi-model-compare`
- For provider failover: `effect-uai-multi-model-fallback`
