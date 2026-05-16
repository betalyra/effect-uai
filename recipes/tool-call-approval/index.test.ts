import { Effect, Fiber, Queue, Schema, Stream, pipe } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, stop, onTurnComplete } from "@effect-uai/core/Loop"
import { type ToolResult, toFunctionCallOutput } from "@effect-uai/core/Outcome"
import { type ToolCallDecision, type Verdict, fromVerdictQueue } from "@effect-uai/core/Resolvers"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Tool from "@effect-uai/core/Tool"
import { type ToolEvent, isApprovalRequested, isOutput } from "@effect-uai/core/ToolEvent"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"

describe("tool-call-approval", () => {
  // --- Tools ---------------------------------------------------------------
  const SearchEmailsInput = Schema.Struct({ query: Schema.String })
  const searchEmails = Tool.make({
    name: "search_emails",
    description: "Search emails.",
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
    description: "Send an email.",
    inputSchema: Tool.fromEffectSchema(SendEmailInput),
    run: ({ to, subject }) => Effect.succeed({ status: "sent", to, subject }),
    strict: true,
  })

  const DeleteUserInput = Schema.Struct({ user_id: Schema.String })
  const deleteUser = Tool.make({
    name: "delete_user",
    description: "Delete a user.",
    inputSchema: Tool.fromEffectSchema(DeleteUserInput),
    run: ({ user_id }) => Effect.succeed({ status: "deleted", user_id }),
    strict: true,
  })

  const allTools: ReadonlyArray<Tool.AnyKindTool> = [searchEmails, sendEmail, deleteUser]

  // --- Approval policy ----------------------------------------------------
  const SENSITIVE: ReadonlySet<string> = new Set(["send_email", "delete_user"])
  const isSensitive = (call: Items.FunctionCall): boolean => SENSITIVE.has(call.name)

  const decisionEvents = (decision: ToolCallDecision): Stream.Stream<ToolEvent> =>
    decision._tag === "Approved"
      ? Toolkit.executeAll(allTools, [decision.call])
      : Stream.succeed(Toolkit.outputEvent(decision.result))

  // --- Loop builder (uses LanguageModel for testability) ------------------
  interface State {
    readonly history: ReadonlyArray<Items.Item>
  }

  const initial: State = {
    history: [Items.userText("ignored - mock decides what comes back")],
  }

  const buildConversation = (verdicts: Queue.Queue<Verdict>) =>
    pipe(
      initial,
      loop((state) =>
        Effect.gen(function* () {
          const lm = yield* LanguageModel
          return lm
            .streamTurn({
              history: state.history,
              model: "mock",
              tools: Tool.toDescriptors(allTools),
            })
            .pipe(
              onTurnComplete((turn) =>
                Effect.sync(() => {
                  const calls = Turn.functionCalls(turn)
                  if (calls.length === 0) return stop

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
                      Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
                    ),
                  )
                }),
              ),
            )
        }),
      ),
    )

  // ------------------------------------------------------------------------

  const fc = (call_id: string, name: string, args: unknown): Items.FunctionCall => ({
    type: "function_call",
    call_id,
    name,
    arguments: JSON.stringify(args),
  })

  const isToolEvent = (e: Turn.TurnEvent | ToolEvent): e is ToolEvent => "_tag" in e

  it("runs safe calls immediately, gates sensitive ones on verdicts, denies cleanly", async () => {
    const turn1: Turn.Turn = {
      stop_reason: "tool_calls",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      items: [
        fc("c-search", "search_emails", { query: "expense" }),
        fc("c-send", "send_email", {
          to: "alice@example.com",
          subject: "Expense report",
          body: "See attached.",
        }),
      ],
    }
    const turn2: Turn.Turn = {
      stop_reason: "tool_calls",
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      items: [fc("c-del", "delete_user", { user_id: "u-deprecated" })],
    }
    const turn3: Turn.Turn = {
      stop_reason: "stop",
      usage: { input_tokens: 30, output_tokens: 5, total_tokens: 35 },
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "All done." }],
        },
      ],
    }

    // Demo policy: approve send_email, deny delete_user.
    const verdictFor = (e: Extract<ToolEvent, { _tag: "ApprovalRequested" }>): Verdict =>
      e.tool === "delete_user"
        ? { call_id: e.call_id, decision: "deny", reason: "Out of scope." }
        : { call_id: e.call_id, decision: "approve" }

    const program = Effect.gen(function* () {
      const verdicts = yield* Queue.unbounded<Verdict>()

      // Tap ApprovalRequested events and post verdicts onto the queue so
      // the gated decisions can resume.
      const tapped = buildConversation(verdicts).pipe(
        Stream.tap((event) =>
          isToolEvent(event) && isApprovalRequested(event)
            ? Queue.offer(verdicts, verdictFor(event))
            : Effect.void,
        ),
      )

      return yield* Stream.runCollect(tapped)
    })

    const events = await Effect.runPromise(
      program.pipe(Effect.provide(MockProvider.layer([turn1, turn2, turn3]))),
    )

    // Two ApprovalRequested events (one per sensitive turn).
    const approvals = events.filter(isToolEvent).filter(isApprovalRequested)
    expect(approvals).toHaveLength(2)
    expect(approvals.map((e) => e.call_id)).toEqual(["c-send", "c-del"])

    // Three Outputs: search ran (Value), send approved (Value), delete denied (Failure).
    const results: ReadonlyArray<ToolResult> = events
      .filter(isToolEvent)
      .filter(isOutput)
      .map((e) => e.result)
    expect(results.map((r) => r.call_id)).toEqual(["c-search", "c-send", "c-del"])

    expect(results[0]).toMatchObject({
      _tag: "Value",
      tool: "search_emails",
      value: { query: "expense" },
    })
    expect(results[1]).toMatchObject({
      _tag: "Value",
      tool: "send_email",
      value: { status: "sent", to: "alice@example.com" },
    })
    expect(results[2]).toMatchObject({
      _tag: "Failure",
      tool: "delete_user",
      kind: "denied",
      reason: "Out of scope.",
    })

    // Loop ran all three turns.
    const turnCompletes = events.filter(
      (e): e is Extract<Turn.TurnEvent, { type: "turn_complete" }> =>
        "type" in e && e.type === "turn_complete",
    )
    expect(turnCompletes).toHaveLength(3)
    expect(turnCompletes[2]!.turn.stop_reason).toBe("stop")
  })

  it("gated calls park until their verdicts arrive on the queue", async () => {
    const turn1: Turn.Turn = {
      stop_reason: "tool_calls",
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      items: [
        fc("a", "send_email", { to: "x@y.com", subject: "s", body: "b" }),
        fc("b", "send_email", { to: "p@q.com", subject: "s", body: "b" }),
      ],
    }
    const turn2: Turn.Turn = {
      stop_reason: "stop",
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      items: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      ],
    }

    const { layer, recorder } = MockProvider.layerWithRecorder([turn1, turn2])

    const program = Effect.gen(function* () {
      const verdicts = yield* Queue.unbounded<Verdict>()

      const fiber = yield* Effect.forkChild(Stream.runDrain(buildConversation(verdicts)))

      // Give the fiber room to issue turn 1 and park on the verdicts queue.
      yield* Effect.sleep("20 millis")
      const before = yield* recorder
      expect(before.calls).toHaveLength(1)

      // Post one verdict; per-call deferreds mean call `a` resumes but `b`
      // still parks - the turn's continueWith only completes when both
      // gated calls have produced a result.
      yield* Queue.offer(verdicts, { call_id: "a", decision: "approve" })
      yield* Effect.sleep("20 millis")
      const middle = yield* recorder
      expect(middle.calls).toHaveLength(1)

      // Second verdict; both gated calls finish, turn completes, turn 2 fires.
      yield* Queue.offer(verdicts, { call_id: "b", decision: "approve" })
      yield* Fiber.join(fiber)

      const after = yield* recorder
      expect(after.calls).toHaveLength(2)
    })

    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })
})

// ---------------------------------------------------------------------------
// HTTP variant tests. The recipe under test imports `httpConversation`
// from index.ts directly. The Responses-typed return type narrows to a
// MockProvider-shaped LanguageModel via `Effect.provide`, so we don't
// need to redefine the loop body inline.
// ---------------------------------------------------------------------------

import { type ApprovalMapEntry, fromApprovalMap } from "@effect-uai/core/Resolvers"

describe("tool-call-approval (HTTP variant)", () => {
  const SearchEmailsInput = Schema.Struct({ query: Schema.String })
  const searchEmails = Tool.make({
    name: "search_emails",
    description: "Search emails.",
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
    description: "Send an email.",
    inputSchema: Tool.fromEffectSchema(SendEmailInput),
    run: ({ to, subject }) => Effect.succeed({ status: "sent", to, subject }),
    strict: true,
  })

  const DeleteUserInput = Schema.Struct({ user_id: Schema.String })
  const deleteUser = Tool.make({
    name: "delete_user",
    description: "Delete a user.",
    inputSchema: Tool.fromEffectSchema(DeleteUserInput),
    run: ({ user_id }) => Effect.succeed({ status: "deleted", user_id }),
    strict: true,
  })

  const allTools: ReadonlyArray<Tool.AnyKindTool> = [searchEmails, sendEmail, deleteUser]
  const SENSITIVE: ReadonlySet<string> = new Set(["send_email", "delete_user"])
  const isSensitive = (call: Items.FunctionCall): boolean => SENSITIVE.has(call.name)

  interface State {
    readonly history: ReadonlyArray<Items.Item>
  }

  // HTTP loop body. Mirrors `httpConversation` from index.ts but against
  // LanguageModel for testability.
  const buildHttpConversation = (
    approvals: ReadonlyMap<string, ApprovalMapEntry>,
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
              tools: Tool.toDescriptors(allTools),
            })
            .pipe(
              onTurnComplete((turn) =>
                Effect.sync(() => {
                  const calls = Turn.functionCalls(turn)
                  if (calls.length === 0) return stop

                  const plan = fromApprovalMap(isSensitive, approvals)(calls)
                  return Stream.merge(
                    Toolkit.executeAll(allTools, plan.approved),
                    Toolkit.outputEvents(plan.rejected),
                  ).pipe(
                    Toolkit.continueWith((results) =>
                      Turn.appendTurn(state, turn, results.map(toFunctionCallOutput)),
                    ),
                  )
                }),
              ),
            )
        }),
      ),
    )

  const fc = (call_id: string, name: string, args: unknown): Items.FunctionCall => ({
    type: "function_call",
    call_id,
    name,
    arguments: JSON.stringify(args),
  })

  const initial: State = {
    history: [Items.userText("ignored - mock decides what comes back")],
  }

  const turnWithMixedCalls: Turn.Turn = {
    stop_reason: "tool_calls",
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    items: [
      fc("c-search", "search_emails", { query: "expense" }),
      fc("c-send", "send_email", {
        to: "alice@example.com",
        subject: "s",
        body: "b",
      }),
      fc("c-del", "delete_user", { user_id: "u" }),
    ],
  }

  const finalTurn: Turn.Turn = {
    stop_reason: "stop",
    usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
    items: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      },
    ],
  }

  it("approve + deny + missing → Value, Failure(denied), Failure(cancelled)", async () => {
    const approvals = new Map<string, ApprovalMapEntry>([
      ["c-send", { decision: "approve" }],
      ["c-del", { decision: "deny", reason: "policy" }],
      // c-search is safe, no approval needed
    ])

    const events = await Effect.runPromise(
      Stream.runCollect(buildHttpConversation(approvals, initial)).pipe(
        Effect.provide(MockProvider.layer([turnWithMixedCalls, finalTurn])),
      ),
    )

    const results: ReadonlyArray<ToolResult> = events
      .filter((e): e is ToolEvent => "_tag" in e)
      .filter(isOutput)
      .map((e) => e.result)

    expect(results.map((r) => r.call_id).sort()).toEqual(["c-del", "c-search", "c-send"])

    const byId = new Map(results.map((r) => [r.call_id, r]))
    expect(byId.get("c-search")).toMatchObject({ _tag: "Value" })
    expect(byId.get("c-send")).toMatchObject({
      _tag: "Value",
      value: { status: "sent" },
    })
    expect(byId.get("c-del")).toMatchObject({
      _tag: "Failure",
      kind: "denied",
      reason: "policy",
    })

    // Pure HTTP: no ApprovalRequested events.
    expect(
      events.filter((e): e is ToolEvent => "_tag" in e).filter(isApprovalRequested),
    ).toHaveLength(0)
  })

  it("missing entries for gated calls become Failure(cancelled)", async () => {
    // No approvals at all - both gated calls cancelled.
    const approvals = new Map<string, ApprovalMapEntry>()

    const events = await Effect.runPromise(
      Stream.runCollect(buildHttpConversation(approvals, initial)).pipe(
        Effect.provide(MockProvider.layer([turnWithMixedCalls, finalTurn])),
      ),
    )

    const results: ReadonlyArray<ToolResult> = events
      .filter((e): e is ToolEvent => "_tag" in e)
      .filter(isOutput)
      .map((e) => e.result)
    const byId = new Map(results.map((r) => [r.call_id, r]))

    expect(byId.get("c-search")).toMatchObject({ _tag: "Value" })
    expect(byId.get("c-send")).toMatchObject({ _tag: "Failure", kind: "cancelled" })
    expect(byId.get("c-del")).toMatchObject({ _tag: "Failure", kind: "cancelled" })
  })
})
