import { Array as Arr, pipe, Result, Schema, Stream } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import * as Items from "@effect-uai/core/Items"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import type * as Turn from "@effect-uai/core/Turn"

export interface Member {
  readonly name: string
  readonly service: LanguageModelService
}

export const ScoreSchema = Schema.Struct({
  score: Schema.Number,
  rationale: Schema.optional(Schema.String),
})
export type Score = typeof ScoreSchema.Type

const ScoreFromJson = Schema.fromJsonString(ScoreSchema)
const decodeScore = Schema.decodeResult(ScoreFromJson)

export type CouncilEvent =
  | {
      readonly type: "candidate_delta"
      readonly member: string
      readonly delta: Turn.TurnEvent
    }
  | {
      readonly type: "candidate_complete"
      readonly member: string
      readonly answer: string
    }
  | {
      readonly type: "score"
      readonly judge: string
      readonly subject: string
      readonly score: number
      readonly rationale: string
    }
  | {
      readonly type: "winner"
      readonly member: string
      readonly answer: string
      readonly averageScore: number
    }
  | {
      readonly type: "error"
      readonly member: string
      readonly phase: "generate" | "judge"
      readonly error: AiError.AiError
    }

const judgeHistory = (
  base: ReadonlyArray<Items.Item>,
  subject: string,
  subjectAnswer: string,
): ReadonlyArray<Items.Item> => [
  Items.systemText(
    'You are an impartial judge. Reply ONLY with a JSON object: {"score": number 0-10, "rationale": short string}.',
  ),
  ...base,
  Items.userText(
    `Candidate answer from ${subject}:\n${subjectAnswer}\n\nScore the answer.`,
  ),
]

const parseScore = (raw: string): Result.Result<Score, AiError.AiError> =>
  Result.mapError(
    decodeScore(raw.trim()),
    (issue) =>
      new AiError.InvalidRequest({
        provider: "council",
        raw: { issue: String(issue), input: raw },
      }),
  )

const judgeStream = (
  judge: Member,
  subject: string,
  subjectAnswer: string,
  history: ReadonlyArray<Items.Item>,
): Stream.Stream<CouncilEvent> =>
  judge.service
    .streamTurn(judgeHistory(history, subject, subjectAnswer), {})
    .pipe(
      Stream.mapAccum(
        () => "",
        (
          acc,
          delta,
        ): readonly [string, ReadonlyArray<CouncilEvent>] => {
          if (delta.type === "text_delta") return [acc + delta.text, []]
          if (delta.type !== "turn_complete") return [acc, []]
          return Result.match(parseScore(acc), {
            onSuccess: (s) => [
              acc,
              [
                {
                  type: "score",
                  judge: judge.name,
                  subject,
                  score: s.score,
                  rationale: s.rationale ?? "",
                },
              ],
            ],
            onFailure: (error) => [
              acc,
              [
                {
                  type: "error",
                  member: judge.name,
                  phase: "judge",
                  error,
                },
              ],
            ],
          })
        },
      ),
      Stream.catch((error) =>
        Stream.succeed<CouncilEvent>({
          type: "error",
          member: judge.name,
          phase: "judge",
          error,
        }),
      ),
    )

const candidatePipeline = (
  member: Member,
  judges: ReadonlyArray<Member>,
  history: ReadonlyArray<Items.Item>,
): Stream.Stream<CouncilEvent> =>
  member.service.streamTurn(history, {}).pipe(
    Stream.mapAccum(
      () => "",
      (acc, delta): readonly [string, ReadonlyArray<CouncilEvent>] => {
        if (delta.type === "text_delta") {
          return [
            acc + delta.text,
            [{ type: "candidate_delta", member: member.name, delta }],
          ]
        }
        if (delta.type === "turn_complete") {
          return [
            acc,
            [{ type: "candidate_complete", member: member.name, answer: acc }],
          ]
        }
        return [
          acc,
          [{ type: "candidate_delta", member: member.name, delta }],
        ]
      },
    ),
    Stream.catch((error) =>
      Stream.succeed<CouncilEvent>({
        type: "error",
        member: member.name,
        phase: "generate",
        error,
      }),
    ),
    Stream.flatMap(
      (event): Stream.Stream<CouncilEvent> => {
        if (event.type !== "candidate_complete") return Stream.succeed(event)
        const otherJudges = pipe(
          judges,
          Arr.filter((j) => j.name !== member.name),
        )
        return Stream.merge(
          Stream.succeed<CouncilEvent>(event),
          Stream.mergeAll(
            otherJudges.map((j) =>
              judgeStream(j, member.name, event.answer, history),
            ),
            { concurrency: "unbounded" },
          ),
        )
      },
      { concurrency: "unbounded" },
    ),
  )

interface SubjectStats {
  readonly sum: number
  readonly count: number
}

interface Tally {
  readonly answers: ReadonlyMap<string, string>
  readonly stats: ReadonlyMap<string, SubjectStats>
}

const emptyTally: Tally = { answers: new Map(), stats: new Map() }

const recordCandidate = (
  tally: Tally,
  member: string,
  answer: string,
): Tally => ({
  ...tally,
  answers: new Map(tally.answers).set(member, answer),
})

const recordScore = (tally: Tally, subject: string, score: number): Tally => {
  const cur = tally.stats.get(subject) ?? { sum: 0, count: 0 }
  return {
    ...tally,
    stats: new Map(tally.stats).set(subject, {
      sum: cur.sum + score,
      count: cur.count + 1,
    }),
  }
}

interface Winner {
  readonly member: string
  readonly answer: string
  readonly averageScore: number
}

const pickWinner = (tally: Tally): Winner | null =>
  pipe(
    Arr.fromIterable(tally.stats.entries()),
    Arr.reduce(null as Winner | null, (best, [member, { sum, count }]) => {
      if (count === 0) return best
      const candidate: Winner = {
        member,
        averageScore: sum / count,
        answer: tally.answers.get(member) ?? "",
      }
      return best === null || candidate.averageScore > best.averageScore
        ? candidate
        : best
    }),
  )

/**
 * Fan a single history out to N members concurrently, cross-evaluate each
 * candidate using every other member as a judge (no self-judging), and
 * stream the winner once all scores are in.
 *
 * Pure stream composition: candidate text accumulates via `mapAccum`; each
 * `candidate_complete` spawns N-1 judge streams via `flatMap`; the outer
 * `mapAccum` tallies scores and emits `winner` on stream halt.
 */
export const council = (
  members: ReadonlyArray<Member>,
  history: ReadonlyArray<Items.Item>,
): Stream.Stream<CouncilEvent> =>
  Stream.mergeAll(
    members.map((m) => candidatePipeline(m, members, history)),
    { concurrency: members.length },
  ).pipe(
    Stream.mapAccum(
      () => emptyTally,
      (tally, event): readonly [Tally, ReadonlyArray<CouncilEvent>] => {
        if (event.type === "candidate_complete") {
          return [recordCandidate(tally, event.member, event.answer), [event]]
        }
        if (event.type === "score") {
          return [recordScore(tally, event.subject, event.score), [event]]
        }
        return [tally, [event]]
      },
      {
        onHalt: (tally) => {
          const winner = pickWinner(tally)
          return winner === null
            ? []
            : [
                {
                  type: "winner",
                  member: winner.member,
                  answer: winner.answer,
                  averageScore: winner.averageScore,
                },
              ]
        },
      },
    ),
  )
