/**
 * Live demo: streaming + HITL combined. Watch the timestamps to see:
 *
 *   - `web_search` starts streaming hits IMMEDIATELY (no approval).
 *   - `bulk_email` and `delete_database` emit `ApprovalRequested` right
 *     away; they sit waiting on the verdict queue.
 *   - At +400ms a scripted "user" approves `bulk_email` (it starts
 *     streaming progress); at +800ms denies `delete_database` (immediate
 *     denied Output).
 *
 * The whole demo is one Stream<DemoEvent> piped through a single sink.
 * Tool events, scripted user actions, and start/done markers are all
 * variants of `DemoEvent`. The only side effect is one `Console.log` in
 * the final `Stream.tap`.
 *
 * Run:
 *   pnpm tsx experiments/streaming-hitl-spike/example/demo.ts
 */
import { Console, Effect, Match, Queue, Schema, Stream } from "effect"
import * as Items from "@effect-uai/core/Items"
import * as Tool from "@effect-uai/core/Tool"
import {
  type ToolEvent,
  type Verdict,
  executeWithApproval,
  streaming,
} from "../lib/index.js"
import { isSensitive } from "./approval.js"
import { deleteDatabase } from "./tools.js"

// ---------------------------------------------------------------------------
// DemoEvent: tool events + scripted user actions + start/done markers.
// ---------------------------------------------------------------------------

interface UserAction {
  readonly _tag: "UserAction"
  readonly decision: "approve" | "deny"
  readonly call_id: string
  readonly tool: string
  readonly reason?: string
}

interface Marker {
  readonly _tag: "Marker"
  readonly text: string
}

type DemoEvent = ToolEvent | UserAction | Marker

// ---------------------------------------------------------------------------
// Pure formatter. Match-discriminator over `_tag`. No side effects.
// ---------------------------------------------------------------------------

const renderEvent: (e: DemoEvent) => string = Match.type<DemoEvent>().pipe(
  Match.tag("Marker", (e) => e.text),
  Match.tag(
    "ApprovalRequested",
    (e) => `APPROVAL_REQUESTED  ${e.call_id} ${e.tool}`,
  ),
  Match.tag(
    "Intermediate",
    (e) =>
      `intermediate        ${e.call_id} ${e.tool}  ${JSON.stringify(e.data)}`,
  ),
  Match.tag(
    "Output",
    (e) => `OUTPUT              ${e.output.call_id}  ${e.output.output}`,
  ),
  Match.tag(
    "UserAction",
    (e) =>
      `[user] ${e.decision.toUpperCase()}  ${e.call_id} (${e.tool})${e.reason ? ` - ${e.reason}` : ""}`,
  ),
  Match.exhaustive,
)

// ---------------------------------------------------------------------------
// Slowed-down streaming tools so the timeline is observable.
// ---------------------------------------------------------------------------

const SearchInput = Schema.Struct({ query: Schema.String })
const slowWebSearch = streaming({
  name: "web_search",
  description: "slow web search",
  inputSchema: Tool.fromEffectSchema(SearchInput),
  run: ({ query }) =>
    Stream.unfold(0, (i: number) =>
      i >= 3
        ? Effect.succeed(undefined)
        : Effect.delay(
            Effect.succeed([
              { url: `https://${i}.example`, title: `${query} #${i}` },
              i + 1,
            ] as const),
            "150 millis",
          ),
    ),
  finalize: (hits) => ({ count: hits.length }),
  strict: true,
})

const BulkEmailInput = Schema.Struct({
  recipients: Schema.Array(Schema.String),
  subject: Schema.String,
})
const slowBulkEmail = streaming({
  name: "bulk_email",
  description: "slow bulk email",
  inputSchema: Tool.fromEffectSchema(BulkEmailInput),
  run: ({ recipients }) =>
    Stream.unfold(0, (i: number) =>
      i >= recipients.length
        ? Effect.succeed(undefined)
        : Effect.delay(
            Effect.succeed([
              { type: "progress" as const, sent: i + 1, total: recipients.length },
              i + 1,
            ] as const),
            "200 millis",
          ),
    ),
  finalize: (events) => ({ status: "sent" as const, delivered: events.length }),
  strict: true,
})

const tools = [slowWebSearch, slowBulkEmail, deleteDatabase]

const fc = (call_id: string, name: string, args: unknown): Items.FunctionCall => ({
  type: "function_call",
  call_id,
  name,
  arguments: JSON.stringify(args),
})

const calls = [
  fc("c1", "web_search", { query: "effect" }),
  fc("c2", "bulk_email", { recipients: ["a@x", "b@x", "c@x"], subject: "Hi" }),
  fc("c3", "delete_database", { name: "prod" }),
]

// ---------------------------------------------------------------------------
// Scripted user. Each step waits, offers a verdict, and emits a
// UserAction event. Sequential by design - the script models a single
// user clicking buttons in order.
// ---------------------------------------------------------------------------

interface UserStep {
  readonly afterMs: number
  readonly tool: string
  readonly verdict: Verdict
}

const userScript: ReadonlyArray<UserStep> = [
  {
    afterMs: 400,
    tool: "bulk_email",
    verdict: { call_id: "c2", decision: "approve" },
  },
  {
    afterMs: 400,
    tool: "delete_database",
    verdict: { call_id: "c3", decision: "deny", reason: "too risky" },
  },
]

const stepToUserAction = (step: UserStep): UserAction => ({
  _tag: "UserAction",
  decision: step.verdict.decision,
  call_id: step.verdict.call_id,
  tool: step.tool,
  ...(step.verdict.reason !== undefined ? { reason: step.verdict.reason } : {}),
})

const userActions = (
  verdicts: Queue.Queue<Verdict>,
): Stream.Stream<DemoEvent> =>
  Stream.fromIterable(userScript).pipe(
    Stream.mapEffect((step) =>
      Effect.delay(
        Queue.offer(verdicts, step.verdict).pipe(
          Effect.as(stepToUserAction(step) satisfies DemoEvent),
        ),
        `${step.afterMs} millis`,
      ),
    ),
  )

// ---------------------------------------------------------------------------
// Wall-clock timestamp for the sink. Single source of impurity.
// ---------------------------------------------------------------------------

const stamp = (() => {
  const start = Date.now()
  return () => `+${(Date.now() - start).toString().padStart(4, " ")}ms`
})()

// ---------------------------------------------------------------------------
// The whole demo: one Stream<DemoEvent>, one tap with Console.log.
// ---------------------------------------------------------------------------

const program = Effect.gen(function* () {
  const verdicts = yield* Queue.unbounded<Verdict>()

  const toolEvents: Stream.Stream<DemoEvent> = executeWithApproval(tools, calls, {
    requiresApproval: isSensitive,
    verdicts,
  })

  const merged = Stream.merge(toolEvents, userActions(verdicts))

  const withMarkers = Stream.fromIterable<DemoEvent>([
    { _tag: "Marker", text: "starting..." },
  ]).pipe(
    Stream.concat(merged),
    Stream.concat(
      Stream.fromIterable<DemoEvent>([{ _tag: "Marker", text: "done." }]),
    ),
  )

  yield* withMarkers.pipe(
    Stream.mapEffect((event) => Console.log(`${stamp()}  ${renderEvent(event)}`)),
    Stream.runDrain,
  )
})

await Effect.runPromise(program)
