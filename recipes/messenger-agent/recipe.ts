/**
 * A tool-using agent that lives in a chat platform. Two pieces:
 *
 *   - `conversation`: an agentic loop with the messenger as its sink. It
 *     waits for input at clean turn boundaries, holds the typing indicator
 *     for the turn, streams the answer into one message and posts a short
 *     status line per tool call.
 *   - `router`: one fiber per conversation, keyed by `conversationKey`. An
 *     addressed message lands in that conversation's inbox; everything else
 *     is ignored.
 *
 * Both name only the `Messenger` and `LanguageModel` tags. Which platform
 * and which model is `app.ts`'s business.
 */
import {
  Array as Arr,
  Cause,
  type Duration,
  Effect,
  Fiber,
  HashMap,
  Match,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
  pipe,
} from "effect"
import * as ImageGenerator from "@effect-uai/core/ImageGenerator"
import { drainBurst } from "@effect-uai/core/Inbox"
import * as Items from "@effect-uai/core/Items"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import { loop, next, onTurnComplete } from "@effect-uai/core/Loop"
import {
  type ConversationRef,
  CurrentConversation,
  type InboundEvent,
  type MessageId,
  Messenger,
  conversationKey,
  inConversation,
  media,
  text,
} from "@effect-uai/core/Messenger"
import * as MessengerError from "@effect-uai/core/MessengerError"
import * as Tool from "@effect-uai/core/Tool"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { webSearchTool } from "@effect-uai/core/WebSearchTool"

export type Options = {
  readonly model: string
  /** Whatever the deployment configured; an absent capability is not offered. */
  readonly toolkit: Toolkit.Toolkit
  /** Seeds every conversation. The place to name the platform's markup. */
  readonly system: string
  /** Answer to `/start`. Sent as-is, so it is in the platform's markup too. */
  readonly greeting?: string
  /** One line per tool call. Sent as-is, so it is in the platform's markup too. */
  readonly status?: (toolName: string) => string
  /** Quiet gap that ends a burst of messages. Default 800ms. */
  readonly settle?: Duration.Input
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const searchTool = webSearchTool({ maxResults: 5 })

/**
 * Reacts to whatever the user said last. The id comes from a `Ref` the loop
 * keeps, since `react` names a message outright while `post` and `typing` ride
 * the ambient conversation. Every platform rejects some emoji, so a refusal
 * comes back as a sentence the model can pass on rather than a failed turn.
 */
const reactTool = (lastMessage: Ref.Ref<Option.Option<MessageId>>) =>
  Tool.make({
    name: "react",
    description: "React to the user's most recent message with a single emoji.",
    inputSchema: Tool.fromEffectSchema(Schema.Struct({ emoji: Schema.String })),
    strict: true,
    run: ({ emoji }) =>
      Effect.gen(function* () {
        const messenger = yield* Messenger
        const at = yield* CurrentConversation
        const target = yield* Ref.get(lastMessage)
        return yield* Option.match(target, {
          onNone: () => Effect.succeed("There is no message to react to yet."),
          onSome: (id) =>
            messenger.react({ conversation: at, id }, emoji).pipe(
              Effect.as("Reacted."),
              Effect.catch((e) => Effect.succeed(MessengerError.describe(e))),
            ),
        })
      }),
  })

/**
 * Draws with whichever `ImageGenerator` is wired and posts the picture into
 * the ambient conversation from inside the tool, so the model only hears
 * that it was sent and never sees the bytes.
 */
export const imageTool = (model: string) =>
  Tool.make({
    name: "generate_image",
    description:
      "Draw a picture from a text prompt and send it to the user. Returns once it is delivered.",
    inputSchema: Tool.fromEffectSchema(Schema.Struct({ prompt: Schema.String })),
    strict: true,
    run: ({ prompt }) =>
      Effect.gen(function* () {
        const messenger = yield* Messenger
        const { images } = yield* ImageGenerator.generate({ prompt, model })
        yield* Effect.forEach(images, ({ image }) => messenger.post(media(image)))
        return "Sent."
      }),
  })

// ---------------------------------------------------------------------------
// The demo persona
// ---------------------------------------------------------------------------

/** The markup the wired platform reads. Nothing converts; the prompt decides. */
export type Markup = "html" | "markdown"

const character = [
  "You are Betty, a helpful agent built with effect-uai, the Effect library for AI agents.",
  "When someone asks who or what you are, say you are Betty, built with effect-uai, and link",
  "effect-uai.betalyra.com. Never call yourself a generic assistant, and never mention the chat",
  "platform, bots or how you are hosted.",
  "Use the tools you have when they help: search for current facts, draw when asked for a picture.",
  "Keep answers short and warm.",
].join(" ")

type Voice = Required<Pick<Options, "system" | "greeting" | "status">>

const voices: Record<Markup, Voice> = {
  html: {
    system: `${character} Format replies as Telegram HTML: <b>, <i>, <code>, <pre>, <a href>. Escape & < > in prose. Never use markdown asterisks or backticks.`,
    greeting: "Hi, I'm <b>Betty</b> 👋",
    status: (name) => `<i>${name}…</i>`,
  },
  markdown: {
    system: `${character} Format replies as Discord markdown: **bold**, *italic*, \`code\`, fenced code blocks and bare links. Never use HTML tags.`,
    greeting: "Hi, I'm **Betty** 👋",
    status: (name) => `*${name}…*`,
  },
}

/** Betty. Her markup is the only platform-specific thing about her. */
export const betty = (markup: Markup): Voice => voices[markup]

// ---------------------------------------------------------------------------
// One conversation
// ---------------------------------------------------------------------------

type State = { readonly history: ReadonlyArray<Items.HistoryItem> }

// The model owes a response after tool outputs; otherwise wait for the user.
const needsUserInput = (state: State): boolean =>
  state.history[state.history.length - 1]?.type !== "function_call_output"

/** What the router hands a conversation: the text, and the message it was. */
export type Incoming = {
  readonly text: string
  readonly id: MessageId
}

/**
 * Run the loop against `inbox` inside the ambient conversation. Each turn
 * acquires `typing` and a delta queue in the iteration's own scope, so the
 * indicator clears and the delivery fiber is reaped when the turn ends.
 *
 * `react` is added here rather than by the caller: it needs this
 * conversation's own last message id, which no shared toolkit could hold.
 */
export const conversation = (inbox: Queue.Queue<Incoming>, options: Options) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const lastMessage = yield* Ref.make(Option.none<MessageId>())
      const tools = Toolkit.fromArray([...Object.values(options.toolkit), reactTool(lastMessage)])

      return pipe(
        { history: [Items.systemText(options.system)] } satisfies State,
        loop((state: State) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const messenger = yield* Messenger
              const lm = yield* LanguageModel

              // Decoration: a rejected status line must not take the answer
              // down with it.
              const status = (name: string) =>
                messenger
                  .post(text((options.status ?? ((n) => `${n}…`))(name)))
                  .pipe(
                    Effect.catch((e) =>
                      Effect.logWarning(`status line dropped: ${MessengerError.describe(e)}`),
                    ),
                  )

              const incoming = needsUserInput(state)
                ? yield* drainBurst(inbox, options.settle ?? "800 millis")
                : []
              // The last of a burst is what "your message" means to the model;
              // a tool-continuation turn drains nothing and keeps the previous.
              yield* Option.match(Arr.last(incoming), {
                onNone: () => Effect.void,
                onSome: (m) => Ref.set(lastMessage, Option.some(m.id)),
              })
              const history = [...state.history, ...incoming.map((m) => Items.userText(m.text))]
              yield* Effect.logDebug("turn starting", {
                drained: incoming.length,
                history: history.length,
              })

              yield* messenger.typing
              const deltas = yield* Queue.unbounded<string, Cause.Done>()
              const delivery = yield* Effect.forkScoped(messenger.stream(Stream.fromQueue(deltas)))

              return lm.streamTurn({ history, model: options.model, tools }).pipe(
                Stream.tap((event) =>
                  Match.value(event).pipe(
                    Match.tag("TextDelta", ({ text }) => Queue.offer(deltas, text)),
                    Match.tag("ToolCallStart", ({ name }) =>
                      Effect.andThen(Effect.logDebug("tool call", { name }), status(name)),
                    ),
                    Match.orElse(() => Effect.void),
                  ),
                ),
                onTurnComplete((turn) =>
                  Effect.gen(function* () {
                    // The final edit lands before the loop moves on; a turn that
                    // said nothing posts nothing.
                    yield* Queue.end(deltas)
                    yield* Fiber.join(delivery)

                    const calls = Turn.getToolCalls(turn)
                    yield* Effect.logDebug("turn complete", {
                      stop: turn.stop_reason,
                      calls: calls.map((c) => c.name),
                    })
                    return calls.length === 0
                      ? next(Turn.appendToHistory({ history }, turn))
                      : Toolkit.run(tools, calls).pipe(
                          Toolkit.continueWithResults(Toolkit.appendToolResults({ history }, turn)),
                        )
                  }),
                ),
              )
            }),
          ),
        ),
      )
    }),
  ).pipe(Stream.runDrain)

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
    const inboxes = yield* Ref.make(HashMap.empty<string, Queue.Queue<Incoming>>())

    const inboxFor = (ref: ConversationRef) =>
      Effect.gen(function* () {
        const key = conversationKey(ref)
        const known = HashMap.get(yield* Ref.get(inboxes), key)
        if (Option.isSome(known)) return known.value
        const inbox = yield* Queue.unbounded<Incoming>()
        yield* Ref.update(inboxes, HashMap.set(key, inbox))
        // Forked, so a conversation that dies must say so: nothing downstream
        // is joining it and the user would just see silence.
        yield* conversation(inbox, options).pipe(
          inConversation(ref),
          // The error itself, not just its cause: a tagged error prints as its
          // name alone, and the fields are the whole story (which verb, why).
          Effect.tapError((e) => Effect.logError(`conversation ${key} stopped`, { error: e })),
          Effect.tapCause((cause) =>
            Effect.logError(`conversation ${key} failed: ${Cause.pretty(cause)}`),
          ),
          Effect.forkScoped,
        )
        return inbox
      })

    /** The inbox of a conversation already under way, if there is one. */
    const openInbox = (ref: ConversationRef) =>
      Effect.map(Ref.get(inboxes), HashMap.get(conversationKey(ref)))

    // Every inbound event, addressed or not: the first thing to look at when a
    // platform delivers nothing, or delivers something the router drops.
    const seen = (event: InboundEvent) =>
      Effect.logDebug("event", {
        tag: event._tag,
        conversation: conversationKey(event.conversation),
        ...(event._tag === "Message" && { addressed: event.addressed, text: event.text }),
        ...(event._tag === "Reaction" && { emoji: event.emoji }),
        ...(event._tag === "Action" && { actionId: event.actionId }),
      })

    yield* Stream.runForEach(messenger.events, (event) =>
      seen(event).pipe(
        Effect.andThen(
          Match.value(event).pipe(
            Match.when({ _tag: "Message", addressed: true }, (message) =>
              Effect.flatMap(inboxFor(message.conversation), (inbox) =>
                Queue.offer(inbox, { text: message.text, id: message.id }),
              ),
            ),
            // An emoji is a turn too, but only in a chat already talking: a
            // reaction is never enough to start a conversation, and reacting
            // to old messages in a quiet channel should stay quiet.
            Match.when({ _tag: "Reaction" }, (reaction) =>
              Effect.flatMap(
                openInbox(reaction.conversation),
                Option.match({
                  onNone: () => Effect.void,
                  onSome: (inbox) =>
                    Queue.offer(inbox, {
                      text: `[reacted ${reaction.emoji}]`,
                      id: reaction.message,
                    }),
                }),
              ),
            ),
            Match.when({ _tag: "Command", name: "start" }, (command) =>
              messenger
                .post(text(options.greeting ?? "Hi! Ask me anything."))
                .pipe(inConversation(command.conversation)),
            ),
            Match.orElse(() => Effect.void),
          ),
        ),
      ),
    )
  })
