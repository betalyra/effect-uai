import { Effect, Fiber, Queue, Schema, Stream, pipe } from "effect"
import { describe, expect, it } from "vitest"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import {
  loop,
  nextAfter,
  stop,
  streamUntilComplete,
  value as loopValue,
} from "@effect-uai/core/Loop"
import * as MockProvider from "@effect-uai/core/testing/MockProvider"
import * as Tool from "@effect-uai/core/Tool"
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

  const toolkit = Toolkit.make([searchEmails, sendEmail, deleteUser])

  // --- Approval policy and types ------------------------------------------
  const SENSITIVE: ReadonlySet<string> = new Set(["send_email", "delete_user"])
  const isSensitive = (call: Items.FunctionCall): boolean => SENSITIVE.has(call.name)

  interface Verdict {
    readonly call_id: string
    readonly decision: "approve" | "deny"
    readonly reason?: string
  }

  interface AwaitingApproval {
    readonly type: "awaiting_approval"
    readonly calls: ReadonlyArray<Items.FunctionCall>
  }

  type ApprovalEvent = AwaitingApproval | Items.FunctionCallOutput

  // --- Verdict collection (recursive drain) -------------------------------
  const collectVerdicts = (
    verdicts: Queue.Dequeue<Verdict>,
    required: ReadonlySet<string>,
  ): Effect.Effect<ReadonlyMap<string, Verdict>> => {
    const go = (
      acc: ReadonlyMap<string, Verdict>,
    ): Effect.Effect<ReadonlyMap<string, Verdict>> =>
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

  const denied = (
    call: Items.FunctionCall,
    reason: string | undefined,
  ): Items.FunctionCallOutput =>
    Items.functionCallOutput(
      call.call_id,
      JSON.stringify({ error: "denied_by_user", reason: reason ?? "User denied this call." }),
    )

  const resolveSensitive = (
    verdicts: Queue.Dequeue<Verdict>,
    sensitive: ReadonlyArray<Items.FunctionCall>,
  ): Effect.Effect<ReadonlyArray<Items.FunctionCallOutput>> =>
    Effect.gen(function* () {
      const required = new Set(sensitive.map((c) => c.call_id))
      const verdictByCallId = yield* collectVerdicts(verdicts, required)
      return yield* Effect.forEach(
        sensitive,
        (call) => {
          const v = verdictByCallId.get(call.call_id)!
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
    })

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
              tools: Toolkit.toDescriptors(toolkit),
            })
            .pipe(
              streamUntilComplete<State, ApprovalEvent>((turn) =>
                Effect.sync(() => {
                  const next = Turn.cursor(state, turn)
                  const calls = Turn.functionCalls(turn)
                  if (calls.length === 0) return stop

                  const sensitive = calls.filter(isSensitive)
                  const safe = calls.filter((c) => !isSensitive(c))

                  const announceItems: ReadonlyArray<AwaitingApproval> =
                    sensitive.length > 0
                      ? [{ type: "awaiting_approval", calls: sensitive }]
                      : []
                  const announce = Stream.fromIterable(announceItems)

                  const continuation = Stream.unwrap(
                    Effect.gen(function* () {
                      const safeOutputs = yield* Toolkit.executeAllSafe(toolkit, safe)
                      const sensitiveOutputs =
                        sensitive.length === 0
                          ? ([] as ReadonlyArray<Items.FunctionCallOutput>)
                          : yield* resolveSensitive(verdicts, sensitive)
                      const outputs: ReadonlyArray<Items.FunctionCallOutput> = [
                        ...safeOutputs,
                        ...sensitiveOutputs,
                      ]
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

  // ------------------------------------------------------------------------

  const fc = (call_id: string, name: string, args: unknown): Items.FunctionCall => ({
    type: "function_call",
    call_id,
    name,
    arguments: JSON.stringify(args),
  })

  it("runs safe calls immediately, gates sensitive ones on verdicts, and denies cleanly", async () => {
    // Turn 1 (mixed): one safe + one sensitive. The body must run the safe
    // call without waiting and emit awaiting_approval for the sensitive one.
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
    // Turn 2 (sensitive only): one sensitive call that the policy will deny.
    const turn2: Turn.Turn = {
      stop_reason: "tool_calls",
      usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      items: [fc("c-del", "delete_user", { user_id: "u-deprecated" })],
    }
    // Turn 3: final answer - no more tool calls, loop stops.
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
    const verdictFor = (call: Items.FunctionCall): Verdict =>
      call.name === "delete_user"
        ? { call_id: call.call_id, decision: "deny", reason: "Out of scope." }
        : { call_id: call.call_id, decision: "approve" }

    const program = Effect.gen(function* () {
      const verdicts = yield* Queue.unbounded<Verdict>()

      // Pre-tap: when we see awaiting_approval flow by, post verdicts onto
      // the queue so the body's parked `collectVerdicts` can resume. The
      // tap runs before runCollect appends the event to its accumulator.
      const tapped = buildConversation(verdicts).pipe(
        Stream.tap((event) =>
          "type" in event && event.type === "awaiting_approval"
            ? Effect.forEach(event.calls, (call) => Queue.offer(verdicts, verdictFor(call)))
            : Effect.void,
        ),
      )

      return yield* Stream.runCollect(tapped)
    })

    const events = await Effect.runPromise(
      program.pipe(Effect.provide(MockProvider.layer([turn1, turn2, turn3]))),
    )

    // Two awaiting_approval events fired (one per sensitive turn).
    const awaiting = events.filter(
      (e): e is AwaitingApproval => "type" in e && e.type === "awaiting_approval",
    )
    expect(awaiting).toHaveLength(2)
    expect(awaiting[0]!.calls.map((c) => c.call_id)).toEqual(["c-send"])
    expect(awaiting[1]!.calls.map((c) => c.call_id)).toEqual(["c-del"])

    // Three function_call_outputs: search ran, send approved-and-ran, delete denied.
    const outputs = events.filter(
      (e): e is Items.FunctionCallOutput =>
        "type" in e && e.type === "function_call_output",
    )
    expect(outputs.map((o) => o.call_id)).toEqual(["c-search", "c-send", "c-del"])

    const searchOutput = JSON.parse(outputs[0]!.output) as { query: string }
    expect(searchOutput.query).toBe("expense")

    const sendOutput = JSON.parse(outputs[1]!.output) as { status: string; to: string }
    expect(sendOutput.status).toBe("sent")
    expect(sendOutput.to).toBe("alice@example.com")

    const deleteOutput = JSON.parse(outputs[2]!.output) as { error: string; reason: string }
    expect(deleteOutput.error).toBe("denied_by_user")
    expect(deleteOutput.reason).toBe("Out of scope.")

    // Loop ran all three turns (turn 3 produced the final answer).
    const turnCompletes = events.filter(
      (e): e is Extract<Turn.TurnEvent, { type: "turn_complete" }> =>
        "type" in e && e.type === "turn_complete",
    )
    expect(turnCompletes).toHaveLength(3)
    expect(turnCompletes[2]!.turn.stop_reason).toBe("stop")
  })

  it("blocks the loop until a verdict arrives for every sensitive call", async () => {
    // Turn 1 has two sensitive calls; turn 2 is the final answer.
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

      // Post a verdict for only one of the two sensitive calls. The body
      // should still be parked - it needs both before it can proceed.
      yield* Queue.offer(verdicts, { call_id: "a", decision: "approve" })
      yield* Effect.sleep("20 millis")
      const middle = yield* recorder
      expect(middle.calls).toHaveLength(1)

      // Post the second verdict; the body resumes, runs both tools, and
      // issues turn 2.
      yield* Queue.offer(verdicts, { call_id: "b", decision: "approve" })
      yield* Fiber.join(fiber)

      const after = yield* recorder
      expect(after.calls).toHaveLength(2)
    })

    await Effect.runPromise(program.pipe(Effect.provide(layer)))
  })
})
