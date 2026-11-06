/**
 * Direct chats. Each message is one request whose response body is the run;
 * the server owns the history. The chat id is the envelopes' `streamId`, so
 * the client learns it from the first answer and sends it with the next
 * message, and `seq` keeps counting across the chat's runs.
 *
 * A dropped request ends its run: closing the response interrupts the agent.
 * Everything lives in memory; a real app persists history.
 */
import type * as Items from "@effect-uai/core/Items"
import { isTurnComplete } from "@effect-uai/core/Turn"
import * as Input from "@effect-uai/ui/Input"
import * as Projection from "@effect-uai/ui/Projection"
import * as Run from "@effect-uai/ui/Run"
import { RunId, StreamId } from "@effect-uai/ui/RunEvent"
import { Data, Effect, HashMap, Option, Ref, Stream } from "effect"
import { SecureRandom } from "effect/crypto"

export class ChatNotFound extends Data.TaggedError("ChatNotFound")<{ readonly chatId: StreamId }> {}

type Chat = {
  readonly id: StreamId
  readonly history: Ref.Ref<ReadonlyArray<Items.HistoryItem>>
  /** The chat's last `seq`: the next run continues from it. */
  readonly lastSeq: Ref.Ref<number>
}

export const makeChats = <E, R>(
  agent: (history: ReadonlyArray<Items.HistoryItem>) => Stream.Stream<Projection.Source, E, R>,
) =>
  Effect.gen(function* () {
    const random = yield* SecureRandom.SecureRandom
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
        history: yield* Ref.make<ReadonlyArray<Items.HistoryItem>>([]),
        lastSeq: yield* Ref.make(0),
      }
      yield* Ref.update(chats, HashMap.set(chat.id, chat))
      return chat
    })

    /**
     * Answer `input` in the chat (a new one when `chatId` is `None`). Fails
     * with `ChatNotFound` before anything streams; the stream is the run.
     */
    const send = (chatId: Option.Option<StreamId>, input: Input.Submit) =>
      Effect.gen(function* () {
        const chat = yield* Option.match(chatId, { onNone: () => create, onSome: find })
        // The question joins the history even if the run is stopped early.
        const history = yield* Ref.updateAndGet(chat.history, (h) => [...h, ...input.messages])
        const runId = RunId.make(yield* random.uuidV7())
        return agent(history).pipe(
          // The turn's items join the history for the next message.
          Stream.tap((source) =>
            isTurnComplete(source)
              ? Ref.update(chat.history, (h) => [...h, ...source.turn.items])
              : Effect.void,
          ),
          Projection.toRunEvents(),
          Run.coalesce("30 millis"),
          Stream.catchCause((cause) => Stream.succeed(Run.failed(cause))),
          Run.complete,
          Run.start({ runId, inputs: [input.id] }),
          Run.sequence(chat.id, { from: yield* Ref.get(chat.lastSeq) }),
          Stream.tap((envelope) => Ref.set(chat.lastSeq, envelope.seq)),
        )
      })

    return { send } as const
  })
