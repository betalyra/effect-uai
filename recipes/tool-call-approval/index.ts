/**
 * Human-in-the-loop tool approval. Sensitive tool calls (`send_email`,
 * `delete_user`) require a verdict before they run; safe ones run
 * immediately.
 *
 * Two transport flavors. Same primitives, different approval planner:
 *
 *   - HTTP (primary)         : approvals arrive synchronously bundled
 *                              with the next request. `fromApprovalMap`
 *                              splits calls into `approved` and `rejected`;
 *                              missing entries synthesize `cancelled`
 *                              outputs.
 *
 *   - Queue (enhancement)    : long-lived channel (WebSocket / SSE).
 *                              `fromVerdictQueue` returns safe calls
 *                              immediately and a stream of later decisions
 *                              for gated calls; `ApprovalRequested` events
 *                              drive the UI.
 *
 * `index.ts` exports the building blocks for both. The runner in
 * `run.ts` drives the queue variant (more visual demo).
 */
import { Effect, Queue, Schema, Stream, pipe } from "effect"
import * as Items from "@effect-uai/core/Items"
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
import { toFunctionCallOutput } from "@effect-uai/core/Outcome"
import {
  type ApprovalMapEntry,
  type ToolCallDecision,
  type Verdict,
  fromApprovalMap,
  fromVerdictQueue,
} from "@effect-uai/core/Resolvers"
import * as Tool from "@effect-uai/core/Tool"
import type { ToolEvent } from "@effect-uai/core/ToolEvent"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { Responses } from "@effect-uai/responses/Responses"

// ---------------------------------------------------------------------------
// Tools - one safe, two sensitive.
// ---------------------------------------------------------------------------

const SearchEmailsInput = Schema.Struct({ query: Schema.String })
const searchEmails = Tool.make({
  name: "search_emails",
  description: "Search the user's recent emails. Returns up to three subject lines.",
  inputSchema: Tool.fromEffectSchema(SearchEmailsInput),
  run: ({ query }) =>
    Effect.succeed({
      query,
      results: [
        "Q3 expense report - final draft",
        "Receipts: Lisbon offsite",
        "Re: corporate card limits",
      ],
    }),
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
  run: ({ to, subject }) =>
    Effect.succeed({ status: "sent", to, subject, sent_at: new Date().toISOString() }),
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

export const allTools: ReadonlyArray<Tool.AnyKindTool> = [searchEmails, sendEmail, deleteUser]
const tools = Tool.toDescriptors(allTools)

const decisionEvents = (decision: ToolCallDecision): Stream.Stream<ToolEvent> =>
  decision._tag === "Approved"
    ? Toolkit.executeAll(allTools, [decision.call])
    : Stream.succeed(Toolkit.outputEvent(decision.result))

// ---------------------------------------------------------------------------
// Approval policy. Sensitivity is just a predicate - swap in anything:
// per-tool, per-arg, role-based, etc.
// ---------------------------------------------------------------------------

const SENSITIVE_TOOLS: ReadonlySet<string> = new Set(["send_email", "delete_user"])
export const isSensitive: (call: Items.FunctionCall) => boolean = (call) =>
  SENSITIVE_TOOLS.has(call.name)

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface State {
  readonly history: ReadonlyArray<Items.Item>
}

export const initial: State = {
  history: [
    Items.userText(
      "Search my emails for the latest expense report, then send a one-line summary " +
        "to alice@example.com. After that, please remove the deprecated user u-deprecated.",
    ),
  ],
}

// ---------------------------------------------------------------------------
// HTTP variant (primary). Approvals are a synchronous map keyed by
// `call_id`; missing entries become `cancelled`. Pure planner, no
// announce stream, no router fiber - the request payload IS the answer.
//
// Typical usage in an HTTP handler:
//
//   const approvals: Map<string, ApprovalMapEntry> =
//     parseApprovalsFromRequestBody(req)
//   const reconciledHistory = [
//     ...storedHistory,
//     ...cancelAllPending(storedHistory).map(toFunctionCallOutput),
//     Items.userText(req.body.message),
//   ]
//   return httpConversation(approvals, { history: reconciledHistory })
// ---------------------------------------------------------------------------

export const httpConversation = (
  approvals: ReadonlyMap<string, ApprovalMapEntry>,
  state: State = initial,
) =>
  pipe(
    state,
    loop((current) =>
      Effect.gen(function* () {
        const oai = yield* Responses
        return oai
          .streamTurn({
            history: current.history,
            model: "gpt-5.4-mini",
            tools,
            reasoning: { effort: "low" },
          })
          .pipe(
            onTurnComplete<State, ToolEvent>((turn) =>
              Effect.sync(() => {
                const calls = Turn.functionCalls(turn)
                if (calls.length === 0) return stop

                const plan = fromApprovalMap(isSensitive, approvals)(calls)
                return Stream.merge(
                  Toolkit.executeAll(allTools, plan.approved),
                  Toolkit.outputEvents(plan.rejected),
                ).pipe(
                  Toolkit.continueWith((results) =>
                    Turn.appendTurn(current, turn, results.map(toFunctionCallOutput)),
                  ),
                )
              }),
            ),
          )
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Queue variant (enhancement). Long-lived channel; verdicts arrive over
// time. `fromVerdictQueue` returns safe calls up-front, plus an `announce`
// stream of `ApprovalRequested` events and a decision stream for gated calls.
// The recipe explicitly chooses what to execute and which rejected results
// to return to the model.
// ---------------------------------------------------------------------------

export const queueConversation = (verdicts: Queue.Queue<Verdict>, state: State = initial) =>
  pipe(
    state,
    loop((current) =>
      Effect.gen(function* () {
        const oai = yield* Responses
        return oai
          .streamTurn({
            history: current.history,
            model: "gpt-5.4-mini",
            tools,
            reasoning: { effort: "low" },
          })
          .pipe(
            onTurnComplete<State, ToolEvent>((turn) =>
              Effect.sync(() => {
                const calls = Turn.functionCalls(turn)
                if (calls.length === 0) return stop

                // Stream.unwrap supplies the Scope that fromVerdictQueue's
                // router fiber lives in. Router stays alive as long as the
                // consumer is pulling from `events`.
                const events = Stream.unwrap(
                  Effect.gen(function* () {
                    const { approved, decisions, announce } = yield* fromVerdictQueue(
                      isSensitive,
                      verdicts,
                    )(calls)
                    return Stream.merge(
                      announce,
                      Stream.merge(
                        Toolkit.executeAll(allTools, approved),
                        decisions.pipe(Stream.flatMap(decisionEvents)),
                      ),
                    )
                  }),
                )

                return events.pipe(
                  Toolkit.continueWith((results) =>
                    Turn.appendTurn(current, turn, results.map(toFunctionCallOutput)),
                  ),
                )
              }),
            ),
          )
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Demo policy for the queue variant. In a real app verdicts come from a
// UI / Slack / approval workflow; here we just decide based on the tool.
// ---------------------------------------------------------------------------

export const demoVerdict = (event: Extract<ToolEvent, { _tag: "ApprovalRequested" }>): Verdict =>
  event.tool === "delete_user"
    ? {
        call_id: event.call_id,
        decision: "deny",
        reason: "Out of scope for this demo - ask an admin to confirm first.",
      }
    : { call_id: event.call_id, decision: "approve" }
