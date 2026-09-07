import { Array as Arr, Data, Effect, Layer, Option, Ref, Stream } from "effect"
import {
  type ConversationRef,
  CurrentConversation,
  type InboundEvent,
  MessageId,
  type MessageRef,
  Messenger,
  type MessengerLimits,
  type MessengerService,
  type Outbound,
  type StreamViaEditsOptions,
  splitForLimit,
  streamViaEdits,
} from "../messenger/Messenger.js"
import * as MessengerError from "../messenger/MessengerError.js"

// ---------------------------------------------------------------------------
// Call log
// ---------------------------------------------------------------------------

/**
 * One entry per outbound call. `Post` is logged once even when the text was
 * long enough to split, so a caller that rolled over on its own is
 * distinguishable from one that leaned on `post` to do it.
 */
export type Call = Data.TaggedEnum<{
  Post: { readonly conversation: ConversationRef; readonly message: Outbound }
  Edit: { readonly message: MessageRef; readonly next: Outbound }
  React: { readonly message: MessageRef; readonly emoji: string }
  TypingStart: { readonly conversation: ConversationRef }
  TypingStop: { readonly conversation: ConversationRef }
}>

export const Call = Data.taggedEnum<Call>()

export type MockMessengerRecorder = {
  readonly calls: ReadonlyArray<Call>
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

export type MockMessengerScript = {
  /** Inbound events to replay. Empty by default. */
  readonly events?: Stream.Stream<InboundEvent, MessengerError.MessengerError>
  readonly limits?: MessengerLimits
  /**
   * Failures handed back one per `post` / `edit` call, in order; `undefined`
   * entries succeed, and everything past the end succeeds.
   */
  readonly failures?: ReadonlyArray<MessengerError.MessengerError | undefined>
  /** Passed through to `streamViaEdits`, which backs `stream`. */
  readonly streamOptions?: StreamViaEditsOptions
}

const defaultLimits: MessengerLimits = { maxText: 4096, maxCaption: 1024 }

const bodyText = (msg: Outbound): Option.Option<string> =>
  msg.body._tag === "Text" ? Option.some(msg.body.text) : Option.none()

// ---------------------------------------------------------------------------
// Service builder
// ---------------------------------------------------------------------------

const buildService = (
  script: MockMessengerScript,
  record: (call: Call) => Effect.Effect<void>,
  cursor: Ref.Ref<number>,
  minted: Ref.Ref<number>,
): MessengerService => {
  const limits = script.limits ?? defaultLimits

  const nextFailure = Ref.getAndUpdate(cursor, (n) => n + 1).pipe(
    Effect.flatMap((i) =>
      Option.match(Option.fromNullishOr((script.failures ?? [])[i]), {
        onNone: () => Effect.void,
        onSome: Effect.fail<MessengerError.MessengerError>,
      }),
    ),
  )

  const mint = Ref.updateAndGet(minted, (n) => n + 1).pipe(Effect.map((n) => MessageId(`m${n}`)))

  const post: MessengerService["post"] = (msg) =>
    Effect.gen(function* () {
      const conversation = yield* CurrentConversation
      yield* record(Call.Post({ conversation, message: msg }))
      yield* nextFailure
      // One id per chunk, mirroring an adapter that splits at the ceiling.
      const chunks = Option.match(bodyText(msg), {
        onNone: () => 1,
        onSome: (t) => splitForLimit(t, limits.maxText).length,
      })
      return yield* Effect.map(
        Effect.forEach(Arr.range(1, chunks), () => mint),
        Arr.lastNonEmpty,
      )
    })

  const edit: MessengerService["edit"] = (msg, next) =>
    record(Call.Edit({ message: msg, next })).pipe(Effect.andThen(nextFailure))

  return {
    events: script.events ?? Stream.empty,
    post,
    edit,
    react: (msg, emoji) => record(Call.React({ message: msg, emoji })),
    typing: Effect.gen(function* () {
      const conversation = yield* CurrentConversation
      yield* record(Call.TypingStart({ conversation }))
      yield* Effect.addFinalizer(() => record(Call.TypingStop({ conversation })))
    }),
    stream: streamViaEdits({ post, edit, limits }, script.streamOptions),
    limits,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const makeUnsafe = (script: MockMessengerScript) => {
  const calls = Ref.makeUnsafe<ReadonlyArray<Call>>([])
  const service = buildService(
    script,
    (call) => Ref.update(calls, Arr.append(call)),
    Ref.makeUnsafe(0),
    Ref.makeUnsafe(0),
  )
  return {
    service,
    recorder: Ref.get(calls).pipe(Effect.map((c): MockMessengerRecorder => ({ calls: c }))),
  }
}

/** Layer registering the mock against the `Messenger` tag, plus its recorder. */
export const layer = (script: MockMessengerScript = {}) => {
  const { service, recorder } = makeUnsafe(script)
  return { layer: Layer.succeed(Messenger, service), recorder }
}

/** Bare service value + recorder. Use with `Effect.provideService`. */
export const make = (script: MockMessengerScript = {}) => makeUnsafe(script)
