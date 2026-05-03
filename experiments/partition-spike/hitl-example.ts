/**
 * Full HITL recipe example using the spike primitives end-to-end.
 *
 * Mirrors `recipes/tool-call-approval/index.ts` but rewritten on top of:
 *   - `executePartitioned` (option-b.ts)
 *   - `denied` and `cancelled` (tool-outcome.ts)
 *   - `parseFailure` for introspecting outputs
 *   - `findUnansweredCalls` / `cancelAllPending` (history-check.ts) for
 *     handling the "follow-up arrives while approvals pending" case
 *
 * Uses `LanguageModel` directly (not `Responses`) so the example is
 * runnable against `MockProvider` without API keys. The companion
 * `hitl-example.test.ts` verifies behavior end-to-end.
 *
 * Toolkit and predicate are module-level so the loop body can keep
 * `ToolsR` concrete (`never`) and `streamUntilComplete<State, A>` types
 * cleanly. The original recipe (`recipes/tool-call-approval/index.ts`)
 * uses the same shape.
 */
import { Array as Arr, Effect, Queue, Result, Schema, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import {
  loop,
  nextAfter,
  stop,
  streamUntilComplete,
  value as loopValue,
} from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { executePartitioned } from "./option-b.js"
import { cancelAllPending } from "./history-check.js"
import { denied } from "./tool-outcome.js"

// ---------------------------------------------------------------------------
// Tools - one safe, two sensitive.
// ---------------------------------------------------------------------------

const SearchEmailsInput = Schema.Struct({ query: Schema.String })
const searchEmails = Tool.make({
  name: "search_emails",
  description: "Search the user's recent emails.",
  inputSchema: Tool.fromEffectSchema(SearchEmailsInput),
  run: ({ query }) => Effect.succeed({ query, results: ["one", "two"] }),
  strict: true,
})

const SendEmailInput = Schema.Struct({
  to: Schema.String,
  subject: Schema.String,
  body: Schema.String,
})
const sendEmail = Tool.make({
  name: "send_email",
  description: "Send an email on behalf of the user.",
  inputSchema: Tool.fromEffectSchema(SendEmailInput),
  run: ({ to, subject }) => Effect.succeed({ status: "sent", to, subject }),
  strict: true,
})

const DeleteUserInput = Schema.Struct({ user_id: Schema.String })
const deleteUser = Tool.make({
  name: "delete_user",
  description: "Permanently delete a user account.",
  inputSchema: Tool.fromEffectSchema(DeleteUserInput),
  run: ({ user_id }) => Effect.succeed({ status: "deleted", user_id }),
  strict: true,
})

export const toolkit = Toolkit.make([searchEmails, sendEmail, deleteUser])

const SENSITIVE: ReadonlySet<string> = new Set(["send_email", "delete_user"])
export const isSensitive = (call: Items.FunctionCall): boolean => SENSITIVE.has(call.name)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Verdict {
  readonly call_id: string
  readonly decision: "approve" | "deny"
  readonly reason?: string
}

export interface AwaitingApproval {
  readonly type: "awaiting_approval"
  readonly calls: ReadonlyArray<Items.FunctionCall>
}

export type ApprovalEvent = AwaitingApproval | Items.FunctionCallOutput

export interface State {
  readonly history: ReadonlyArray<Items.Item>
}

// ---------------------------------------------------------------------------
// Verdict drain - recipe-local policy: ignore unknown call_ids and
// duplicates, block until every required call has a verdict.
// ---------------------------------------------------------------------------

export const collectVerdicts = (
  verdicts: Queue.Dequeue<Verdict>,
  required: ReadonlySet<string>,
): Effect.Effect<ReadonlyMap<string, Verdict>> => {
  const go = (acc: ReadonlyMap<string, Verdict>): Effect.Effect<ReadonlyMap<string, Verdict>> =>
    acc.size >= required.size
      ? Effect.succeed(acc)
      : Effect.flatMap(Queue.take(verdicts), (v) =>
          go(
            required.has(v.call_id) && !acc.has(v.call_id)
              ? new Map(acc).set(v.call_id, v)
              : acc,
          ),
        )
  return go(new Map())
}

// ---------------------------------------------------------------------------
// The loop - the whole point of the spike: how thin is the body?
// ---------------------------------------------------------------------------

export const buildConversation = (
  verdicts: Queue.Queue<Verdict>,
  initial: State,
) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        const lm = yield* LanguageModel
        return lm
          .streamTurn({
            history: state.history,
            model: "mock",
            tools: Toolkit.toDescriptors(toolkit),
          })
          .pipe(
            streamUntilComplete<State, ApprovalEvent>((turn) =>
              Effect.sync(() => {
                const next = Turn.cursor(state, turn)
                const calls = Turn.functionCalls(turn)
                if (calls.length === 0) return stop

                // Announce which calls are gated, before parking. The
                // recipe owns the announce-then-resolve stream timing.
                const [_safe, sensitive] = Arr.partition(calls, (c) =>
                  isSensitive(c) ? Result.succeed(c) : Result.fail(c),
                )
                const announce = Stream.fromIterable<AwaitingApproval>(
                  sensitive.length > 0 ? [{ type: "awaiting_approval", calls: sensitive }] : [],
                )

                const continuation = Stream.unwrap(
                  Effect.gen(function* () {
                    const outputs = yield* executePartitioned(toolkit, calls, {
                      predicate: isSensitive,
                      onGated: (gated) =>
                        Effect.gen(function* () {
                          const required = new Set(gated.map((c) => c.call_id))
                          const byId = yield* collectVerdicts(verdicts, required)
                          return yield* Effect.forEach(
                            gated,
                            (call) => {
                              const v = byId.get(call.call_id)!
                              return v.decision === "approve"
                                ? Toolkit.executeOne(toolkit, call).pipe(
                                    Effect.catchTag("ToolError", (err) =>
                                      Effect.succeed(Toolkit.defaultRepair(err, call)),
                                    ),
                                  )
                                : Effect.succeed(denied(call, v.reason))
                            },
                            { concurrency: "unbounded" },
                          )
                        }),
                    })
                    return nextAfter(Stream.fromIterable<ApprovalEvent>(outputs), {
                      ...next,
                      history: [...next.history, ...outputs],
                    })
                  }),
                )

                return Stream.concat(
                  Stream.map(announce, (a) => loopValue<ApprovalEvent>(a)),
                  continuation,
                )
              }),
            ),
          )
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Reconciliation helper - given a checkpoint history that may have orphan
// function_calls (e.g. a stateless HTTP server received a new user
// message while approvals were pending), append cancellation outputs so
// the next provider request is well-formed.
// ---------------------------------------------------------------------------

export const reconcile = (
  history: ReadonlyArray<Items.Item>,
  reason?: string,
): ReadonlyArray<Items.Item> => [...history, ...cancelAllPending(history, reason)]
