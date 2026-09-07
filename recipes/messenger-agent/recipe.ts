/**
 * A tool-using agent that lives in a chat platform. Two pieces:
 *
 *   - `conversation`: the agentic loop from `recipes/agentic-loop`, with the
 *     messenger as its sink. It waits for input at clean turn boundaries,
 *     holds the typing indicator for the turn, streams the answer into one
 *     message and posts a short status line per tool call.
 *   - `router`: one fiber per conversation, keyed by `conversationKey`. An
 *     addressed message lands in that conversation's inbox; everything else
 *     is ignored.
 *
 * Both name only the `Messenger` and `LanguageModel` tags. Which platform
 * and which model is `app.ts`'s business.
 */
import {
  Cause,
  type Duration,
  Effect,
  Fiber,
  HashMap,
  Match,
  Option,
  Queue,
  Ref,
  Stream,
  pipe,
} from "effect"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, next, onTurnComplete } from "@effect-uai/core/Loop"
import {
  type ConversationRef,
  Messenger,
  conversationKey,
  inConversation,
  text,
} from "@effect-uai/core/Messenger"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { drainBurst } from "../agentic-loop/recipe.js"

export type Options = {
  readonly model: string
  readonly toolkit: Toolkit.Toolkit
  /** Seeds every conversation. The place to name the platform's markup. */
  readonly system: string
  /** Answer to `/start`. Sent as-is, so it is in the platform's markup too. */
  readonly greeting?: string
  /** Quiet gap that ends a burst of messages. Default 800ms. */
  readonly settle?: Duration.Input
}

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------

type State = { readonly history: ReadonlyArray<Items.HistoryItem> }

// The model owes a response after tool outputs; otherwise wait for the user.
const needsUserInput = (state: State): boolean =>
  state.history[state.history.length - 1]?.type !== "function_call_output"

/**
 * Run the loop against `inbox` inside the ambient conversation. Each turn
 * acquires `typing` and a delta queue in the iteration's own scope, so the
 * indicator clears and the delivery fiber is reaped when the turn ends.
 */
export const conversation = (inbox: Queue.Queue<string>, options: Options) =>
  pipe(
    { history: [Items.systemText(options.system)] } satisfies State,
    loop((state: State) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const messenger = yield* Messenger
          const lm = yield* LanguageModel

          const incoming = needsUserInput(state)
            ? yield* drainBurst(inbox, options.settle ?? "800 millis")
            : []
          const history = [...state.history, ...incoming.map(Items.userText)]

          yield* messenger.typing
          const deltas = yield* Queue.unbounded<string, Cause.Done>()
          const spoke = yield* Ref.make(false)
          const delivery = yield* Effect.forkScoped(messenger.stream(Stream.fromQueue(deltas)))

          return lm.streamTurn({ history, model: options.model, tools: options.toolkit }).pipe(
            Stream.tap((event) =>
              Match.value(event).pipe(
                Match.tag("TextDelta", ({ text }) =>
                  Effect.andThen(Ref.set(spoke, true), Queue.offer(deltas, text)),
                ),
                Match.tag("ToolCallStart", ({ name }) => messenger.post(text(`<i>${name}…</i>`))),
                Match.orElse(() => Effect.void),
              ),
            ),
            onTurnComplete((turn) =>
              Effect.gen(function* () {
                // Decided by what was streamed, not by the assembled turn: a
                // turn that said nothing gets no message, and one that did
                // always gets its final edit.
                const saidSomething = yield* Ref.get(spoke)
                yield* saidSomething
                  ? Effect.andThen(Queue.end(deltas), Fiber.join(delivery))
                  : Fiber.interrupt(delivery)

                const calls = Turn.getToolCalls(turn)
                return calls.length === 0
                  ? next(Turn.appendToHistory({ history }, turn))
                  : Toolkit.run(options.toolkit, calls).pipe(
                      Toolkit.continueWithResults(Toolkit.appendToolResults({ history }, turn)),
                    )
              }),
            ),
          )
        }),
      ),
    ),
    Stream.runDrain,
  )

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Dispatch inbound events to per-conversation fibers. The first addressed
 * message in a conversation creates its inbox and forks its loop into the
 * caller's scope; `/start` gets a greeting and nothing else.
 */
export const router = (options: Options) =>
  Effect.gen(function* () {
    const messenger = yield* Messenger
    const inboxes = yield* Ref.make(HashMap.empty<string, Queue.Queue<string>>())

    const inboxFor = (ref: ConversationRef) =>
      Effect.gen(function* () {
        const key = conversationKey(ref)
        const known = HashMap.get(yield* Ref.get(inboxes), key)
        if (Option.isSome(known)) return known.value
        const inbox = yield* Queue.unbounded<string>()
        yield* Ref.update(inboxes, HashMap.set(key, inbox))
        // Forked, so a conversation that dies must say so: nothing downstream
        // is joining it and the user would just see silence.
        yield* conversation(inbox, options).pipe(
          inConversation(ref),
          Effect.tapCause((cause) =>
            Effect.logError(`conversation ${key} failed: ${Cause.pretty(cause)}`),
          ),
          Effect.forkScoped,
        )
        return inbox
      })

    yield* Stream.runForEach(messenger.events, (event) =>
      Match.value(event).pipe(
        Match.when({ _tag: "Message", addressed: true }, (message) =>
          Effect.flatMap(inboxFor(message.conversation), (inbox) =>
            Queue.offer(inbox, message.text),
          ),
        ),
        Match.when({ _tag: "Command", name: "start" }, (command) =>
          messenger
            .post(text(options.greeting ?? "Hi! Ask me anything."))
            .pipe(inConversation(command.conversation)),
        ),
        Match.orElse(() => Effect.void),
      ),
    )
  })
