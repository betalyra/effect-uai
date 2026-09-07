---
title: Messenger agent
description: A tool-using agent that lives in a chat platform. One fiber per conversation, the typing indicator held for the turn, the answer streamed into a single message.
source: recipes/messenger-agent
icon: PiChatCircleDots
---

The [agentic loop](/recipes/agentic-loop/) reads from a queue and writes to
stdout. This recipe keeps that loop and swaps both ends for a `Messenger`: the
queue is fed by addressed messages from a chat platform, and the answer goes
back as one progressively edited message.

**Scenario.** A Telegram bot with web search. DM it, or mention it in a
group, and it shows typing, posts a one-line status per tool call, then
streams its answer into a single message. Every conversation has its own loop
and its own history.

## The Design Move

Nothing in the loop knows it is talking to Telegram. It yields the generic
`Messenger` tag, and the conversation it is speaking to is ambient:

```ts
conversation(inbox, options).pipe(inConversation(ref), Effect.forkScoped)
```

`inConversation(ref)` puts a `CurrentConversation` in context once, at the
fiber boundary. Every `post`, `typing` and `stream` below it, including a
tool posting progress from deep inside `Toolkit.run`, lands in that chat
without threading a ref through the loop.

## Per turn

Each iteration of the loop acquires two things in its own scope:

```ts
yield * messenger.typing
const deltas = yield * Queue.unbounded<string, Cause.Done>()
const delivery = yield * Effect.forkScoped(messenger.stream(Stream.fromQueue(deltas)))
```

The turn stream is tapped: text deltas go into the queue, a `ToolCallStart`
becomes a status post. On `TurnComplete` the queue is ended and the delivery
fiber joined, so the final edit lands before the loop moves on. When the
iteration's stream closes, its scope releases the typing indicator.

A turn that only called tools produced no text; the delivery fiber is
interrupted instead of joined, so no empty message is posted.

## Router

```ts
yield *
  Stream.runForEach(messenger.events, (event) =>
    Match.value(event).pipe(
      Match.when({ _tag: "Message", addressed: true }, (message) =>
        Effect.flatMap(inboxFor(message.conversation), (inbox) => Queue.offer(inbox, message.text)),
      ),
      Match.when({ _tag: "Command", name: "start" }, (command) =>
        messenger.post(text(greeting)).pipe(inConversation(command.conversation)),
      ),
      Match.orElse(() => Effect.void),
    ),
  )
```

`inboxFor` creates the inbox and forks the loop the first time a conversation
is seen, keyed by `conversationKey`. Unaddressed group chatter never reaches a
model.

## Formatting is the prompt's job

`Text` is sent verbatim. The system prompt asks for Telegram HTML because the
wired layer sends it under `parse_mode: "HTML"`; on Slack that line would ask
for markdown. Nothing in the library converts. If the model emits something
Telegram cannot parse, the adapter resends the same text plain.

## Run it

Create a bot with [@BotFather](https://t.me/BotFather), then:

```sh
TELEGRAM_BOT_TOKEN=123:abc EXA_API_KEY=... OPENAI_API_KEY=... \
  pnpm tsx recipes/messenger-agent/run.ts
```

DM the bot. For group mentions, turn privacy mode off in BotFather
(`/setprivacy`) or make the bot an admin; with it on, Telegram only delivers
commands, replies to the bot and DMs.

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/messenger-agent/recipe.ts).
