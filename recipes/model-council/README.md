---
title: Model council
description: Three models answer the same question, score each other's answers (no self-judging), and the highest-rated answer is streamed as the winner.
---

**Scenario.** You have a question and three different models (OpenAI,
Google, Anthropic). You want all three to answer concurrently, then
have each model score the _others'_ answers, and finally surface the
winner — both who won and what they said. Everything streams; nothing
blocks longer than it has to.

The only barrier is the `winner` event itself: it lands the moment
the last of the six judge calls returns. Candidate text streams live;
each judge call fires the instant its subject finishes (it does not
wait on its own answer or on the other judges).

If you only want side-by-side answers without cross-evaluation, see
[multi-model compare](/recipes/multi-model-compare/).

## What it shows

- **Pure stream composition** — no `Queue`, no `Deferred`, no manual
  forks. The dependency graph is implicit in where `flatMap` runs.
- **`Stream.mapAccum`** for two jobs: per-candidate text accumulation
  (so the `candidate_complete` event can carry the full answer) and
  the global score tally (so the `winner` event can be emitted at the
  right moment).
- **`Stream.flatMap` as a spawn point** — when a `candidate_complete`
  flows through, it's replaced with a merged stream of `[the event
itself, ...judge streams for that subject]`. Judges over the same
  subject share the subject's answer in scope.
- **`Schema.fromJsonString`** to parse the judge's `{score,
rationale}` JSON in one shot. Decode failures map to typed
  `AiError.InvalidRequest` and surface as `error` events with `phase:
"judge"` instead of silently scoring zero.
- **Per-phase error isolation** — a candidate's generate failure
  cancels nothing else; a judge's failure surfaces as one `error`
  event and the remaining judges continue.

## The event taxonomy

```ts
export type CouncilEvent =
  | { type: "candidate_delta"; member: string; delta: TurnDelta }
  | { type: "candidate_complete"; member: string; answer: string }
  | { type: "score"; judge: string; subject: string; score: number; rationale: string }
  | { type: "winner"; member: string; answer: string; averageScore: number }
  | { type: "error"; member: string; phase: "generate" | "judge"; error: AiError }
```

A consumer that just wants the verdict can `runCollect` the stream
and `find(e => e.type === "winner")`. A consumer that wants live UX
can render `candidate_delta`, then drop in scores as they arrive,
then highlight the winner.

## The pattern

The library bit lives in
[`council.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/model-council/council.ts).
The shape, in three layers:

**Per candidate** — accumulate text, emit deltas live, emit complete
on terminal:

```ts
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
const ScoreSchema = Schema.Struct({
  score: Schema.Number,
  rationale: Schema.optional(Schema.String),
})
const decodeScore = Schema.decodeResult(Schema.fromJsonString(ScoreSchema))

const judgeStream = (judge, subject, subjectAnswer, history) =>
  judge.service
    .streamTurn({
      history: judgeHistory(history, subject, subjectAnswer),
      model: judge.model,
    })
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

**Top level** — merge all candidate pipelines, tally scores, emit
winner on halt:

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
        if (event.type === "score") return [recordScore(tally, event.subject, event.score), [event]]
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
scores are "expected" (which gets tricky when a candidate fails and
no one judges it), we wait until the entire upstream stream halts and
then pick the best from whatever scores actually landed.

## Why per-judge error isolation matters

If one model returns malformed JSON, you don't want it to silently
score zero (which would unfairly penalize the subject it was judging)
_and_ you don't want it to take the whole council down. Schema decode
failures become typed `AiError.InvalidRequest` events with `phase:
"judge"` — the rest of the scores still land, the tally still
averages over what arrived, and the winner is still emitted.

Same for transport failures (`RateLimited`, `Unavailable`, etc.):
`Stream.catch` turns them into `error` events of the right phase.

## Run it

```sh
OPENAI_API_KEY=sk-... GOOGLE_API_KEY=... ANTHROPIC_API_KEY=... \
  pnpm tsx recipes/model-council/index.ts
```

The runner streams each candidate's text live (prefixed with the
member name), logs each score as it lands, and prints a final summary
that shows **who won** and what they said:

```
================================================================
  WINNER: anthropic/claude-sonnet-4-6  (average score 8.50)
================================================================

A black hole is a place in space where gravity is so strong that...

----- judge scores -----
  openai/gpt-5.4-mini -> google/gemini-3-flash-preview: 7  (...)
  openai/gpt-5.4-mini -> anthropic/claude-sonnet-4-6: 9  (...)
  google/gemini-3-flash-preview -> openai/gpt-5.4-mini: 6  (...)
  google/gemini-3-flash-preview -> anthropic/claude-sonnet-4-6: 8  (...)
  anthropic/claude-sonnet-4-6 -> openai/gpt-5.4-mini: 7  (...)
  anthropic/claude-sonnet-4-6 -> google/gemini-3-flash-preview: 7  (...)
```

The full source lives next to this README at
[`recipes/model-council/`](https://github.com/betalyra/effect-uai/tree/main/recipes/model-council).

## Caveats

- **Self-bias.** Even with the no-self-judging rule, models tend to
  prefer answers that match their own style. Averaging across the two
  judges per subject mitigates but does not eliminate this — read the
  scores, not just the winner.
- **JSON discipline.** A judge model that ignores the "JSON only"
  instruction will produce a parse failure for that judge call. The
  recipe handles it gracefully, but the affected subject loses one
  vote.
- **Cost.** Three generations + six judge calls = nine LLM calls per
  question. Use cheap-tier models for production fan-out.
