/**
 * Durable chats. A chat is one event stream that carries every run, plus the
 * history the server owns. Runs execute in a server-owned worker, not in HTTP
 * requests, so a client can drop, reload and re-open the chat without losing
 * anything: the stream is a PubSub with replay, so a reader gets the whole
 * chat so far and then the live tail.
 *
 * Messages queue: each chat has an inbox and one worker. A burst of messages,
 * or messages sent while a run is going, get one answer together. Everything lives in
 * memory; a real app persists events and history.
 */
import type * as Items from "@effect-uai/core/Items"
import * as Settle from "@effect-uai/core/Settle"
import { isTurnComplete } from "@effect-uai/core/Turn"
import * as Input from "@effect-uai/ui/Input"
import * as Projection from "@effect-uai/ui/Projection"
import * as Run from "@effect-uai/ui/Run"
import { type Envelope, RunId, type RunEvent, StreamId } from "@effect-uai/ui/RunEvent"
import {
  type Array as Arr,
  Data,
  Deferred,
  type Duration,
  Effect,
  FiberMap,
  Option,
  PubSub,
  Queue,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import { SecureRandom } from "effect/crypto"

export class ChatNotFound extends Data.TaggedError("ChatNotFound")<{ readonly chatId: StreamId }> {}

type Chat = {
  readonly id: StreamId
  readonly inbox: Queue.Queue<Input.Submit>
  readonly events: PubSub.PubSub<Envelope>
  /** Assigns the next `seq` and publishes; `send` and the worker both write. */
  readonly publish: (event: RunEvent, runId?: RunId) => Effect.Effect<void>
  readonly history: Ref.Ref<ReadonlyArray<Items.HistoryItem>>
  /** The running run's stop signal, if a run is going. */
  readonly running: Ref.Ref<Option.Option<Deferred.Deferred<void>>>
}

const encodeInput = Schema.encodeEffect(Input.SubmitJson)

export const makeChats = <E, R>(
  agent: (history: ReadonlyArray<Items.HistoryItem>) => Stream.Stream<Projection.Source, E, R>,
  options?: {
    /** How long the worker waits for more messages before answering a burst. */
    readonly settle?: Duration.Input
  },
) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom
    const workers = yield* FiberMap.make<StreamId>()
    const chats = yield* Ref.make<ReadonlyMap<StreamId, Chat>>(new Map())

    const find = (chatId: StreamId) =>
      Ref.get(chats).pipe(
        Effect.flatMap((m) =>
          Option.match(Option.fromNullishOr(m.get(chatId)), {
            onNone: () => Effect.fail(new ChatNotFound({ chatId })),
            onSome: Effect.succeed,
          }),
        ),
      )

    // One run answers a batch: every message that queued up while the chat was busy.
    const runBatch = (chat: Chat, inputs: Arr.NonEmptyReadonlyArray<Input.Submit>) =>
      Effect.gen(function* () {
        const stop = yield* Deferred.make<void>()
        yield* Ref.set(chat.running, Option.some(stop))
        // The questions join the history even if the run is stopped early.
        const history = yield* Ref.updateAndGet(chat.history, (h) => [
          ...h,
          ...inputs.flatMap(Input.toHistory),
        ])
        const runId = RunId.make(yield* random.uuidV7())
        yield* agent(history).pipe(
          // The turn's items join the history for the next message.
          Stream.tap((source) =>
            isTurnComplete(source)
              ? Ref.update(chat.history, (h) => [...h, ...source.turn.items])
              : Effect.void,
          ),
          Projection.toRunEvents(),
          Run.coalesce("30 millis"),
          Run.withTerminal({
            runId,
            inputs: inputs.map((i) => i.id),
            stopWhen: Deferred.await(stop),
          }),
          Stream.runForEach((event) => chat.publish(event, runId)),
        )
      }).pipe(Effect.ensuring(Ref.set(chat.running, Option.none())))

    const create = Effect.gen(function* () {
      // UUIDv4: the chat id is all a reader needs, so keep it unguessable.
      const id = StreamId.make(yield* random.uuidV4())
      // Replay everything: a re-opened chat gets every run.
      const events = yield* PubSub.unbounded<Envelope>({ replay: Number.POSITIVE_INFINITY })
      const lastSeq = yield* Ref.make(0)
      const lock = yield* Semaphore.make(1)
      const chat: Chat = {
        id,
        inbox: yield* Queue.unbounded<Input.Submit>(),
        events,
        publish: (event, runId) =>
          Ref.updateAndGet(lastSeq, (n) => n + 1).pipe(
            Effect.flatMap((seq) =>
              PubSub.publish(
                events,
                runId === undefined
                  ? { streamId: id, seq, event }
                  : { streamId: id, seq, runId, event },
              ),
            ),
            Effect.asVoid,
            Semaphore.withPermit(lock),
          ),
        history: yield* Ref.make<ReadonlyArray<Items.HistoryItem>>([]),
        running: yield* Ref.make(Option.none<Deferred.Deferred<void>>()),
      }
      yield* Ref.update(chats, (m) => new Map(m).set(id, chat))
      // The chat's worker: one run at a time. Messages sent in a burst, or
      // while a run is going, are answered together by the next run.
      yield* FiberMap.run(
        workers,
        id,
        Effect.forever(
          Settle.drainBurst(chat.inbox, options?.settle ?? "300 millis").pipe(
            Effect.flatMap((batch) => runBatch(chat, batch)),
          ),
        ),
      )
      return chat
    })

    /**
     * Queue a message, creating the chat when `chatId` is `None`. The input is
     * echoed on the chat's stream right away (stream-scoped `data "input"`),
     * so a reloaded page shows it even while it waits; its run follows.
     */
    const send = (chatId: Option.Option<StreamId>, input: Input.Submit) =>
      Effect.gen(function* () {
        const chat = yield* Option.match(chatId, { onNone: () => create, onSome: find })
        const value = yield* encodeInput(input)
        yield* chat.publish({ type: "data", name: "input", value })
        yield* Queue.offer(chat.inbox, input)
        return chat.id
      })

    /** The chat's envelopes after `after`: replay, then live. Never ends. */
    const events = (chatId: StreamId, after: number) =>
      find(chatId).pipe(
        Effect.map((chat) =>
          Stream.fromPubSub(chat.events).pipe(Stream.filter((e) => e.seq > after)),
        ),
      )

    /** Stop the running run; its `run-stopped` arrives, then the next queued message runs. */
    const stop = (chatId: StreamId) =>
      find(chatId).pipe(
        Effect.flatMap((chat) => Ref.get(chat.running)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (d) => Deferred.succeed(d, undefined),
          }),
        ),
      )

    return { send, events, stop } as const
  })
