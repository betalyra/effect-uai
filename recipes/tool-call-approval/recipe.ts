/**
 * Human-in-the-loop tool approval. Sensitive tool calls (`send_email`,
 * `delete_user`) require a decision before they run; safe ones run
 * immediately.
 *
 * Two transport flavors, same pieces:
 *
 *   - HTTP (primary)         : decisions arrive bundled with the next
 *                              request. `Approval.Default.resolve` groups the
 *                              waiting calls; a call without an answer is
 *                              closed as cancelled.
 *
 *   - Queue (enhancement)    : long-lived channel (WebSocket / SSE).
 *                              `fromQueue` runs safe calls at once and each
 *                              gated call when its answer arrives (or closes
 *                              it as cancelled after `timeout`).
 *                              `ApprovalRequested` events drive the UI.
 *
 * A denied or cancelled call still gets an output, so the model's next turn is
 * valid: an `Output` failure with `Approval.Denied` (declared by the sensitive
 * tools) or core's `ToolOutput.Cancelled`, encoded like any other outcome.
 *
 * This file exports the building blocks for both. `app.ts` drives the
 * queue variant (more visual demo).
 */
import * as Approval from "@effect-uai/core/Approval"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import * as Tool from "@effect-uai/core/Tool"
import * as ToolOutput from "@effect-uai/core/ToolOutput"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import {
  Deferred,
  type Duration,
  Effect,
  Match,
  Option,
  Queue,
  Ref,
  type Scope,
  Schema,
  Stream,
  pipe,
} from "effect"

// ---------------------------------------------------------------------------
// Tools - one safe, two sensitive.
// ---------------------------------------------------------------------------

const searchEmails = Tool.make({
  name: "search_emails",
  description: "Search the user's recent emails. Returns up to three subject lines.",
  inputSchema: Schema.Struct({ query: Schema.String }),
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

// The sensitive tools declare `Denied`: the app may close their calls with it.
const sendEmail = Tool.make({
  name: "send_email",
  description: "Send an email on behalf of the user.",
  inputSchema: Schema.Struct({ to: Schema.String, subject: Schema.String, body: Schema.String }),
  failureSchema: Approval.Denied,
  run: ({ to, subject }) =>
    Effect.succeed({ status: "sent", to, subject, sent_at: new Date().toISOString() }),
  strict: true,
})

const deleteUser = Tool.make({
  name: "delete_user",
  description: "Permanently delete a user account.",
  inputSchema: Schema.Struct({ user_id: Schema.String }),
  failureSchema: Approval.Denied,
  run: ({ user_id }) => Effect.succeed({ status: "deleted", user_id }),
  strict: true,
})

export const toolkit = Toolkit.make(searchEmails, sendEmail, deleteUser)

// ---------------------------------------------------------------------------
// Approval policy. Sensitivity is just a predicate - swap in anything:
// per-tool, per-arg, role-based, etc.
// ---------------------------------------------------------------------------

const SENSITIVE_TOOLS: ReadonlySet<string> = new Set(["send_email", "delete_user"])
export const isSensitive: (call: Items.ToolCall) => boolean = (call) =>
  SENSITIVE_TOOLS.has(call.name)

/** What a user can answer: approve, or deny with an optional reason. */
export type Decision = typeof Approval.Default.schema.Type
export type Answer = Approval.Answer<Decision>

// ---------------------------------------------------------------------------
// Closing calls the app decided itself
// ---------------------------------------------------------------------------

/** The model sees a closed call like any failed one; `Denied` only on the sensitive tools. */
export const close = (call: Items.ToolCall, error: Approval.Denied | ToolOutput.Cancelled) =>
  Toolkit.close(toolkit, call, error)
type Closed = Effect.Success<ReturnType<typeof close>>

const denied = (reason: string | undefined) =>
  new Approval.Denied({ message: reason ?? "The user denied this call." })

/** The UI's cue: this call waits for an answer. */
export type ApprovalRequested = {
  readonly _tag: "ApprovalRequested"
  readonly call: Items.ToolCall
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface State {
  readonly history: ReadonlyArray<Items.HistoryItem>
}

export const initial: State = {
  history: [
    Items.userText(
      "Search my emails for the latest expense report, then send a one-line summary " +
        "to alice@example.com. After that, please remove the deprecated user u-deprecated.",
    ),
  ],
}

export const DEFAULT_MODEL = "gpt-5.4-mini"

// ---------------------------------------------------------------------------
// HTTP variant (primary). Answers come with the request; the payload IS the
// decision. Typical usage in an HTTP handler:
//
//   const answers = yield* Schema.decodeUnknownEffect(Schema.Array(Answer))(req.body.answers)
//   const closing = yield* HistoryCheck.cancelAllPending(storedHistory)
//   return httpConversation(answers, {
//     history: [...storedHistory, ...closing, Items.userText(req.body.message)],
//   })
// ---------------------------------------------------------------------------

export const httpConversation = (
  answers: ReadonlyArray<Answer>,
  state: State = initial,
  model = DEFAULT_MODEL,
) =>
  pipe(
    state,
    loop((current: State) =>
      Effect.gen(function* () {
        const lm = yield* LanguageModel
        return lm.streamTurn({ history: current.history, model, tools: toolkit }).pipe(
          onTurnComplete((turn) =>
            Effect.gen(function* () {
              const calls = Turn.getToolCalls(turn)
              if (calls.length === 0) return stop()

              const { Approve, Deny, unanswered } = Approval.Default.resolve(
                calls.filter(isSensitive),
                answers,
              )
              const closed = yield* Effect.all([
                ...Deny.map(({ call, decision }) => close(call, denied(decision.reason))),
                ...unanswered.map((call) =>
                  close(call, new ToolOutput.Cancelled({ message: "No approval was given." })),
                ),
              ])
              const run = [...calls.filter((c) => !isSensitive(c)), ...Approve.map((a) => a.call)]
              return Stream.merge(Toolkit.run(toolkit, run), Stream.fromIterable(closed)).pipe(
                Toolkit.next(toolkit, current, turn),
              )
            }),
          ),
        )
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Queue variant (enhancement). Answers arrive over time on a queue. Safe
// calls run at once; each gated call announces `ApprovalRequested` and then
// runs or closes once its answer (or the timeout) arrives. Single consumer:
// the router retires once every gated call is settled.
// ---------------------------------------------------------------------------

type Settled = Decision | ToolOutput.Cancelled

export const fromQueue =
  (
    predicate: (call: Items.ToolCall) => boolean,
    answers: Queue.Dequeue<Answer>,
    options?: { readonly timeout?: Duration.Input },
  ) =>
  (
    calls: ReadonlyArray<Items.ToolCall>,
  ): Effect.Effect<
    Stream.Stream<
      Toolkit.Event<typeof toolkit> | Closed | ApprovalRequested,
      Toolkit.UndeclaredFailure
    >,
    never,
    Scope.Scope
  > =>
    Effect.gen(function* () {
      const gated = calls.filter(predicate)
      const safe = calls.filter((call) => !predicate(call))
      const pending = new Map(
        yield* Effect.forEach(gated, (call) =>
          Deferred.make<Settled>().pipe(Effect.map((d) => [call.call_id, { call, d }] as const)),
        ),
      )
      const outstanding = yield* Ref.make(gated.length)

      // Count only the winning completion, so a late answer is a no-op.
      const settle = (id: string, settled: Settled) =>
        Option.match(Option.fromNullishOr(pending.get(id)), {
          onNone: () => Effect.void,
          onSome: ({ d }) =>
            Deferred.succeed(d, settled).pipe(
              Effect.flatMap((won) => (won ? Ref.update(outstanding, (n) => n - 1) : Effect.void)),
            ),
        })

      const route: Effect.Effect<void> = Ref.get(outstanding).pipe(
        Effect.flatMap((n) =>
          n <= 0
            ? Effect.void
            : Queue.take(answers).pipe(
                Effect.flatMap((a) => settle(a.callId, a.decision)),
                Effect.andThen(Effect.suspend(() => route)),
              ),
        ),
      )

      if (gated.length > 0) {
        yield* Effect.forkScoped(route)
        if (options?.timeout !== undefined) {
          const timedOut = new ToolOutput.Cancelled({ message: "The approval timed out." })
          yield* Effect.forkScoped(
            Effect.sleep(options.timeout).pipe(
              Effect.andThen(Effect.forEach(gated, (call) => settle(call.call_id, timedOut))),
            ),
          )
        }
      }

      const onceSettled = ({ call, d }: { call: Items.ToolCall; d: Deferred.Deferred<Settled> }) =>
        Stream.unwrap(
          Effect.map(Deferred.await(d), (settled) =>
            Match.value(settled).pipe(
              Match.tagsExhaustive({
                Approve: () => Toolkit.run(toolkit, [call]),
                Deny: ({ reason }) => Stream.fromEffect(close(call, denied(reason))),
                Cancelled: (cancelled) => Stream.fromEffect(close(call, cancelled)),
              }),
            ),
          ),
        )

      const requests = Stream.fromIterable(
        gated.map((call): ApprovalRequested => ({ _tag: "ApprovalRequested", call })),
      )
      const settled = Stream.fromIterable(pending.values()).pipe(
        Stream.flatMap(onceSettled, { concurrency: "unbounded" }),
      )
      return requests.pipe(Stream.merge(Toolkit.run(toolkit, safe)), Stream.merge(settled))
    })

export const queueConversation = (
  answers: Queue.Queue<Answer>,
  state: State = initial,
  model = DEFAULT_MODEL,
) =>
  pipe(
    state,
    loop((current: State) =>
      Effect.gen(function* () {
        const lm = yield* LanguageModel
        return lm.streamTurn({ history: current.history, model, tools: toolkit }).pipe(
          onTurnComplete((turn) =>
            Effect.sync(() => {
              const calls = Turn.getToolCalls(turn)
              if (calls.length === 0) return stop()
              // Stream.unwrap supplies the Scope the router fiber lives in: it
              // stays alive as long as the consumer pulls.
              return Stream.unwrap(fromQueue(isSensitive, answers)(calls)).pipe(
                Toolkit.next(toolkit, current, turn),
              )
            }),
          ),
        )
      }),
    ),
  )

// ---------------------------------------------------------------------------
// Demo policy for the queue variant. In a real app answers come from a
// UI / Slack / approval workflow; here we just decide based on the tool.
// ---------------------------------------------------------------------------

export const demoAnswer = ({ call }: ApprovalRequested): Answer => ({
  callId: call.call_id,
  decision:
    call.name === "delete_user"
      ? Approval.Default.Deny({
          reason: "Out of scope for this demo - ask an admin to confirm first.",
        })
      : Approval.Default.Approve(),
})
