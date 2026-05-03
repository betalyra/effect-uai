/**
 * Human-in-the-loop tool approval. Some tool calls (`send_email`,
 * `delete_user`) require a verdict before they run; others run immediately.
 *
 * The body partitions each turn's tool calls into safe vs sensitive,
 * launches the safe ones via `executeAllSafe`, emits an `awaiting_approval`
 * event for the sensitive ones, then waits on a `Queue<Verdict>` for the
 * external decision before executing or denying. Either path produces a
 * `FunctionCallOutput` so the model sees what happened on the next turn.
 *
 * Run with: `OPENAI_API_KEY=sk-... pnpm tsx recipes/tool-call-approval/index.ts`
 */
import {
  Config,
  Effect,
  Layer,
  Logger,
  Match,
  Queue,
  References,
  Schema,
  Stream,
  pipe,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import * as Items from "@effect-uai/core/Items";
import {
  loop,
  nextAfter,
  stop,
  streamUntilComplete,
  value as loopValue,
} from "@effect-uai/core/Loop";
import { matchType } from "@effect-uai/core/Match";
import * as Tool from "@effect-uai/core/Tool";
import * as Toolkit from "@effect-uai/core/Toolkit";
import * as Turn from "@effect-uai/core/Turn";
import { Responses, layer as responsesLayer } from "@effect-uai/responses";

// ---------------------------------------------------------------------------
// Tools - one safe, two sensitive.
// ---------------------------------------------------------------------------

const SearchEmailsInput = Schema.Struct({ query: Schema.String });
const searchEmails = Tool.make({
  name: "search_emails",
  description:
    "Search the user's recent emails. Returns up to three subject lines.",
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
});

const SendEmailInput = Schema.Struct({
  to: Schema.String,
  subject: Schema.String,
  body: Schema.String,
});
const sendEmail = Tool.make({
  name: "send_email",
  description: "Send an email on behalf of the user.",
  inputSchema: Tool.fromEffectSchema(SendEmailInput),
  run: ({ to, subject }) =>
    Effect.succeed({
      status: "sent",
      to,
      subject,
      sent_at: new Date().toISOString(),
    }),
  strict: true,
});

const DeleteUserInput = Schema.Struct({ user_id: Schema.String });
const deleteUser = Tool.make({
  name: "delete_user",
  description: "Permanently delete a user account.",
  inputSchema: Tool.fromEffectSchema(DeleteUserInput),
  run: ({ user_id }) => Effect.succeed({ status: "deleted", user_id }),
  strict: true,
});

const toolkit = Toolkit.make([searchEmails, sendEmail, deleteUser]);
const tools = Toolkit.toDescriptors(toolkit);

// ---------------------------------------------------------------------------
// Approval policy and types
// ---------------------------------------------------------------------------

// Sensitivity is just a predicate. Swap in anything: per-tool, per-arg, etc.
const SENSITIVE_TOOLS: ReadonlySet<string> = new Set([
  "send_email",
  "delete_user",
]);
const isSensitive = (call: Items.FunctionCall): boolean =>
  SENSITIVE_TOOLS.has(call.name);

interface Verdict {
  readonly call_id: string;
  readonly decision: "approve" | "deny";
  readonly reason?: string;
}

// Custom event the body emits in addition to TurnEvents and FunctionCallOutputs.
interface AwaitingApproval {
  readonly type: "awaiting_approval";
  readonly calls: ReadonlyArray<Items.FunctionCall>;
}

type ApprovalEvent = AwaitingApproval | Items.FunctionCallOutput;

// ---------------------------------------------------------------------------
// Verdict collection - drain one verdict per required call_id, ignoring
// unknown call_ids and duplicates.
// ---------------------------------------------------------------------------

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
        );
  return go(new Map());
};

const denied = (
  call: Items.FunctionCall,
  reason: string | undefined,
): Items.FunctionCallOutput =>
  Items.functionCallOutput(
    call.call_id,
    JSON.stringify({
      error: "denied_by_user",
      reason: reason ?? "User denied this call.",
    }),
  );

const resolveSensitive = (
  verdicts: Queue.Dequeue<Verdict>,
  sensitive: ReadonlyArray<Items.FunctionCall>,
): Effect.Effect<
  ReadonlyArray<Items.FunctionCallOutput>,
  never,
  Toolkit.ToolsR<(typeof toolkit)["tools"]>
> =>
  Effect.gen(function* () {
    const required = new Set(sensitive.map((c) => c.call_id));
    const verdictByCallId = yield* collectVerdicts(verdicts, required);
    return yield* Effect.forEach(
      sensitive,
      (call) => {
        const v = verdictByCallId.get(call.call_id)!;
        return v.decision === "approve"
          ? Toolkit.executeOne(toolkit, call).pipe(
              Effect.catchTag("ToolError", (err) =>
                Effect.succeed(Toolkit.defaultRepair(err, call)),
              ),
            )
          : Effect.succeed(denied(call, v.reason));
      },
      { concurrency: "unbounded" },
    );
  });

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface State {
  readonly history: ReadonlyArray<Items.Item>;
}

const initial: State = {
  history: [
    Items.userText(
      "Search my emails for the latest expense report, then send a one-line summary " +
        "to alice@example.com. After that, please remove the deprecated user u-deprecated.",
    ),
  ],
};

// ---------------------------------------------------------------------------
// The loop - safe + sensitive partition, announce-then-resolve emission.
// ---------------------------------------------------------------------------

const conversation = (verdicts: Queue.Queue<Verdict>) =>
  pipe(
    initial,
    loop((state) =>
      Effect.gen(function* () {
        const oai = yield* Responses;
        return oai
          .streamTurn({
            history: state.history,
            model: "gpt-5.4-mini",
            tools,
            reasoning: { effort: "low" },
          })
          .pipe(
            streamUntilComplete<State, ApprovalEvent>((turn) =>
              Effect.sync(() => {
                const next = Turn.cursor(state, turn);
                const calls = Turn.functionCalls(turn);
                if (calls.length === 0) return stop;

                const sensitive = calls.filter(isSensitive);
                const safe = calls.filter((c) => !isSensitive(c));

                // Announce the awaiting-approval set NOW so downstream sees
                // it before we park on the queue. `Stream.concat` pulls
                // `announce` to completion before pulling `continuation`,
                // so the consumer learns of pending approvals immediately
                // and can post verdicts while we're parked.
                const announceItems: ReadonlyArray<AwaitingApproval> =
                  sensitive.length > 0
                    ? [{ type: "awaiting_approval", calls: sensitive }]
                    : [];
                const announce = Stream.fromIterable(announceItems);

                const continuation = Stream.unwrap(
                  Effect.gen(function* () {
                    const safeOutputs = yield* Toolkit.executeAllSafe(
                      toolkit,
                      safe,
                    );
                    const sensitiveOutputs =
                      sensitive.length === 0
                        ? []
                        : yield* resolveSensitive(verdicts, sensitive);
                    const outputs: ReadonlyArray<Items.FunctionCallOutput> = [
                      ...safeOutputs,
                      ...sensitiveOutputs,
                    ];
                    return nextAfter(
                      Stream.fromIterable<ApprovalEvent>(outputs),
                      {
                        ...next,
                        history: [...next.history, ...outputs],
                      },
                    );
                  }),
                );

                return Stream.concat(
                  Stream.map(announce, (a) => loopValue<ApprovalEvent>(a)),
                  continuation,
                );
              }),
            ),
          );
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Demo policy - approve `send_email`, deny `delete_user`.
// In a real app the verdicts come from a UI / Slack / approval workflow;
// here we just simulate human latency and decide based on tool name.
// ---------------------------------------------------------------------------

const demoVerdict = (call: Items.FunctionCall): Verdict =>
  call.name === "delete_user"
    ? {
        call_id: call.call_id,
        decision: "deny",
        reason: "Out of scope for this demo - ask an admin to confirm first.",
      }
    : { call_id: call.call_id, decision: "approve" };

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const verdicts = yield* Queue.unbounded<Verdict>();

  yield* Stream.runForEach(conversation(verdicts), (event) =>
    Match.value(event).pipe(
      matchType("awaiting_approval", ({ calls }) =>
        Effect.gen(function* () {
          yield* Effect.logInfo("awaiting approval", {
            calls: calls.map((c) => ({ name: c.name, call_id: c.call_id })),
          });
          // Simulate user think-time, then post a verdict per call.
          yield* Effect.sleep("400 millis");
          yield* Effect.forEach(calls, (call) =>
            Queue.offer(verdicts, demoVerdict(call)),
          );
        }),
      ),
      matchType("function_call_output", (output) =>
        Effect.logInfo("tool output", {
          call_id: output.call_id,
          output: output.output,
        }),
      ),
      matchType("turn_complete", ({ turn }) =>
        Effect.logInfo("turn complete", { stop_reason: turn.stop_reason }),
      ),
      Match.orElse(() => Effect.void),
    ),
  );
});

const apiKeyLayer = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("OPENAI_API_KEY");
    return responsesLayer({ apiKey });
  }),
);

const runtime = Layer.mergeAll(
  apiKeyLayer.pipe(Layer.provide(FetchHttpClient.layer)),
  Logger.layer([Logger.consolePretty()]),
);

Effect.runPromise(
  program.pipe(
    Effect.provide(runtime),
    Effect.provideService(References.MinimumLogLevel, "Info"),
  ),
).catch((err) => {
  console.error("recipe failed:", err);
  process.exit(1);
});
