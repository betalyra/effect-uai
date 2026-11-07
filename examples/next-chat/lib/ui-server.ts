/**
 * The `/ui` page's server: `POST /api/ui/chat { chatId?, input }` answers with
 * the run as SSE. One request per input; the server keeps the history. The chat
 * id is the envelopes' `streamId`, so the page learns it from the first answer
 * and sends it back. In memory.
 *
 * The route is a plain Effect `HttpRouter` route; `HttpRouter.toWebHandler`
 * turns it into the `(Request) => Promise<Response>` a Next.js route exports.
 * A closed request interrupts the run.
 */
import * as Approval from "@effect-uai/core/Approval"
import * as Items from "@effect-uai/core/Items"
import type { ToolCall } from "@effect-uai/core/Items"
import type { LanguageModelService } from "@effect-uai/core/LanguageModel"
import { loop, onTurnComplete, stop, value } from "@effect-uai/core/Loop"
import * as ToolEvent from "@effect-uai/core/ToolEvent"
import * as ToolResult from "@effect-uai/core/ToolResult"
import { toToolCallOutput } from "@effect-uai/core/ToolResult"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import * as Metrics from "@effect-uai/core/Metrics"
import * as Input from "@effect-uai/ui/Input"
import * as Projection from "@effect-uai/ui/Projection"
import * as Run from "@effect-uai/ui/Run"
import { RunId, type RunEvent, StreamId } from "@effect-uai/ui/RunEvent"
import * as SseEncoding from "@effect-uai/ui/SseEncoding"
import {
  Array as Arr,
  Data,
  Duration,
  Effect,
  HashMap,
  HashSet,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import { BookTable, ChatUi, SendEmail } from "./chat-ui"
import { readProvider } from "./model"
import { toolkit } from "./tools"

// APPROVAL POLICY: plain functions, change them freely

/** Calls that need the user's yes before they run. */
const needsApproval = (call: ToolCall): boolean =>
  call.name === SendEmail.name || call.name === BookTable.name

/**
 * What a new message does to a call still waiting for approval: `deny` it, or
 * `keep` it open so the user can approve it after a follow-up question.
 */
const onFollowUp = (call: ToolCall): "deny" | "keep" =>
  call.name === SendEmail.name ? "keep" : "deny"

// AGENT: model turns until it stops calling tools, or calls one that needs approval

type History = ReadonlyArray<Items.HistoryItem>

const makeAgent =
  (service: LanguageModelService, model: string) =>
  (history: History, parked: Ref.Ref<ReadonlyArray<ToolCall>>) =>
    loop(({ history }: { readonly history: History }) =>
      service.streamTurn({ history, model, tools: toolkit }).pipe(
        onTurnComplete((turn) =>
          Effect.gen(function* () {
            const calls = Turn.getToolCalls(turn)
            if (calls.length === 0) return stop()
            const gated = calls.filter(needsApproval)
            if (gated.length === 0) {
              return Toolkit.run(toolkit, calls).pipe(
                Toolkit.continueWithResults(Toolkit.appendToolResults({ history }, turn)),
              )
            }
            // Run the calls that need no approval, park the rest, and end the run.
            yield* Ref.set(parked, gated)
            return Toolkit.run(
              toolkit,
              calls.filter((call) => !needsApproval(call)),
            ).pipe(Stream.map(value), Stream.concat(stop()))
          }),
        ),
      ),
    )({ history })

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))

// The run's terminal when calls were parked: the page shows them as awaiting approval.
const interrupted = (calls: ReadonlyArray<ToolCall>): RunEvent => ({
  type: "run-interrupted",
  interrupts: calls.map((call) => ({
    callId: call.call_id,
    reason: "approval",
    name: call.name,
    input: Option.getOrElse(parseJson(call.arguments), () => call.arguments),
  })),
})

// What one loop event adds to the chat's history: the turn's items, a tool's output.
const historyOf = (source: Projection.Source): History => {
  if (Turn.isTurnComplete(source)) return source.turn.items
  if (ToolEvent.isOutput(source)) return [toToolCallOutput(source.result)]
  return []
}

// METRICS: time to first token and throughput, sent as the contract's `live` values

const estimateTokens = (event: Turn.TurnEvent): Effect.Effect<number> =>
  Effect.succeed(event._tag === "TextDelta" ? [...event.text].length / 4 : 0)

const isFirstToken = (e: Metrics.MetricEvent): e is Metrics.TimeToFirstToken =>
  e._tag === "TimeToFirstToken"
const isThroughput = (e: Metrics.MetricEvent): e is Metrics.Throughput => e._tag === "Throughput"

const liveMetric = (
  event: Metrics.MetricEvent,
): Effect.Effect<ReadonlyArray<RunEvent>, Schema.SchemaError> => {
  if (isFirstToken(event) && event.kind === "text") {
    return ChatUi.live("ttftMs", Math.round(Duration.toMillis(event.elapsed))).pipe(
      Effect.map(Arr.of),
    )
  }
  if (isThroughput(event)) {
    return ChatUi.live("tokensPerSecond", Math.round(event.ratePerSecond)).pipe(Effect.map(Arr.of))
  }
  return Effect.succeed([])
}

// The loop's events go through `Projection`; metric samples become `live` events.
const toRunEvents = <E, R>(self: Stream.Stream<Projection.Source | Metrics.MetricEvent, E, R>) =>
  self.pipe(
    Stream.mapAccumEffect(
      () => Projection.initial,
      (state, event) =>
        Metrics.isMetricEvent(event)
          ? liveMetric(event).pipe(Effect.map((events) => [state, events] as const))
          : Effect.succeed(Projection.step()(state, event)),
    ),
  )

// CHATS: history, the last `seq` and the waiting calls per chat id

class ChatNotFound extends Data.TaggedError("ChatNotFound")<{ readonly chatId: StreamId }> {}

type Chat = {
  readonly id: StreamId
  readonly history: Ref.Ref<History>
  readonly lastSeq: Ref.Ref<number>
  /** Calls waiting for the user's verdict. */
  readonly awaiting: Ref.Ref<ReadonlyArray<ToolCall>>
  /** Waiting calls that already have a placeholder output in `history`. */
  readonly held: Ref.Ref<HashSet.HashSet<string>>
}

const PLACEHOLDER = "Not run yet: waiting for the user's approval."

const makeChats = Effect.gen(function* () {
  const { service, model } = yield* readProvider
  const agent = makeAgent(service, model)
  const random = yield* SecureRandom.SecureRandom
  // The tools call the network; approved calls run while handling a request.
  const http = yield* Effect.context<HttpClient.HttpClient>()
  const chats = yield* Ref.make(HashMap.empty<StreamId, Chat>())

  const find = (chatId: StreamId) =>
    Ref.get(chats).pipe(
      Effect.flatMap((m) => Effect.fromOption(HashMap.get(m, chatId))),
      Effect.mapError(() => new ChatNotFound({ chatId })),
    )

  const create = Effect.gen(function* () {
    // UUIDv4: the chat id is all a caller needs, so keep it unguessable.
    const chat: Chat = {
      id: StreamId.make(yield* random.uuidV4()),
      history: yield* Ref.make<History>([]),
      lastSeq: yield* Ref.make(0),
      awaiting: yield* Ref.make<ReadonlyArray<ToolCall>>([]),
      held: yield* Ref.make(HashSet.empty<string>()),
    }
    yield* Ref.update(chats, HashMap.set(chat.id, chat))
    return chat
  })

  // A new message: apply `onFollowUp` to every waiting call. Every call needs an
  // output before the model's next turn, so a kept call gets a placeholder (once).
  const onMessage = (chat: Chat, input: Input.Submit) =>
    Effect.gen(function* () {
      const awaiting = yield* Ref.get(chat.awaiting)
      const held = yield* Ref.get(chat.held)
      const kept = awaiting.filter((call) => onFollowUp(call) === "keep")
      const superseded = awaiting
        .filter((call) => onFollowUp(call) === "deny")
        .map((call) =>
          ToolResult.failed(call, "superseded", "The user sent a new message instead."),
        )
      const placeholders = kept
        .filter((call) => !HashSet.has(held, call.call_id))
        .map((call) => Items.toolCallOutput(call.call_id, PLACEHOLDER))
      yield* Ref.update(chat.history, (h) => [
        ...h,
        ...superseded.map(toToolCallOutput),
        ...placeholders,
        ...input.messages,
      ])
      yield* Ref.set(chat.awaiting, kept)
      yield* Ref.update(chat.held, (s) =>
        kept.reduce((acc, call) => HashSet.add(acc, call.call_id), s),
      )
      return superseded
    })

  // A verdict: only calls this chat is waiting for count; the client votes, the
  // server decides. Check here who may approve what.
  const onResolve = (chat: Chat, input: Input.Resolve) =>
    Effect.gen(function* () {
      const awaiting = yield* Ref.get(chat.awaiting)
      const held = yield* Ref.get(chat.held)
      const verdicts = new Map(
        input.decisions.map((d): readonly [string, Approval.ApprovalMapEntry] => [
          d.callId,
          d.approved
            ? { decision: "approve" }
            : { decision: "deny", ...(d.reason !== undefined ? { reason: d.reason } : {}) },
        ]),
      )
      const decided = awaiting.filter((call) => verdicts.has(call.call_id))
      const plan = Approval.fromMap(needsApproval, verdicts)(decided)
      const ran = yield* Toolkit.run(toolkit, plan.approved).pipe(
        Stream.filterMap((event) =>
          ToolEvent.isOutput(event) ? Result.succeed(event.result) : Result.failVoid,
        ),
        Stream.runCollect,
        Effect.provideContext(http),
      )
      const results = [...ran, ...plan.rejected]
      // A call with a placeholder already has its output; it learns the verdict from a note.
      const items = results.map((result) =>
        HashSet.has(held, result.call_id)
          ? Items.userText(
              `[${ToolResult.isOk(result) ? "approved" : "not run"}] ${result.tool} (${result.call_id}): ${toToolCallOutput(result).output}`,
            )
          : toToolCallOutput(result),
      )
      yield* Ref.update(chat.history, (h) => [...h, ...items])
      yield* Ref.set(
        chat.awaiting,
        awaiting.filter((call) => !verdicts.has(call.call_id)),
      )
      return results
    })

  /** Answer `input` in the chat (a new one without `chatId`); the stream is the run. */
  const send = (chatId: Option.Option<StreamId>, input: Input.Input) =>
    Effect.gen(function* () {
      const chat = yield* Option.match(chatId, { onNone: () => create, onSome: find })
      const results =
        input.kind === "submit" ? yield* onMessage(chat, input) : yield* onResolve(chat, input)
      const history = yield* Ref.get(chat.history)
      const parked = yield* Ref.make<ReadonlyArray<ToolCall>>([])
      const runId = RunId.make(yield* random.uuidV7())
      // A verdict for nothing we wait for has nothing to answer.
      const answer =
        input.kind === "resolve" && results.length === 0
          ? Stream.empty
          : agent(history, parked).pipe(
              Stream.tap((source) => Ref.update(chat.history, (h) => [...h, ...historyOf(source)])),
              Metrics.allMetrics({
                throughput: { every: "500 millis", unit: "token", tokenizer: estimateTokens },
              }),
            )
      // Parked calls end the run as interrupted and wait in `chat.awaiting`.
      const interrupt = Stream.unwrap(
        Ref.get(parked).pipe(
          Effect.tap((calls) => Ref.update(chat.awaiting, (a) => [...a, ...calls])),
          Effect.map((calls) =>
            calls.length === 0 ? Stream.empty : Stream.make(interrupted(calls)),
          ),
        ),
      )
      // The settled calls' results go first, so their cards update.
      return Stream.fromIterable(
        results.map((result) => ToolEvent.ToolEvent.Output({ result })),
      ).pipe(
        Stream.concat(answer),
        toRunEvents,
        Run.coalesce("30 millis"),
        // The client gets the error's tag; the details stay in the server log.
        Stream.catchCause((cause) =>
          Stream.fromEffect(Effect.logError(cause).pipe(Effect.as(Run.failed(cause)))),
        ),
        Stream.concat(interrupt),
        Run.start({ runId, inputs: [input.id] }),
        Run.complete,
        Run.sequence(chat.id, { from: yield* Ref.get(chat.lastSeq) }),
        Stream.tap((envelope) => Ref.set(chat.lastSeq, envelope.seq)),
      )
    })

  return { send }
})

// ROUTE

// A message or a verdict (`Input.resolve`).
const ChatBody = Schema.Struct({ chatId: Schema.optionalKey(StreamId), input: Input.InputJson })

const ChatRoute = Layer.unwrap(
  Effect.gen(function* () {
    const chats = yield* makeChats
    // The run streams after the handler returns, so it carries its services along.
    const context = yield* Effect.context<HttpClient.HttpClient>()
    return HttpRouter.add(
      "POST",
      "/api/ui/chat",
      HttpServerRequest.schemaBodyJson(ChatBody).pipe(
        Effect.flatMap(({ chatId, input }) => chats.send(Option.fromNullishOr(chatId), input)),
        Effect.map((run) =>
          HttpServerResponse.stream(run.pipe(Stream.provideContext(context), SseEncoding.encode), {
            headers: SseEncoding.responseHeaders,
          }),
        ),
        Effect.catchTags({
          ChatNotFound: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
          SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
        }),
      ),
    )
  }),
)

// Built once per server process; the Next.js route hands it each request.
export const { handler } = HttpRouter.toWebHandler(
  ChatRoute.pipe(
    Layer.provide(Layer.mergeAll(FetchHttpClient.layer, SecureRandom.layerWebCrypto)),
    Layer.provide(HttpServer.layerServices),
  ),
)
