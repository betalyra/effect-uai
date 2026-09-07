---
title: Messenger agent
description: Put the agent where people already are. Mention it in Telegram; it types, searches the web, and streams the answer into one message. One loop and one history per conversation.
source: recipes/messenger-agent
icon: PiChatsCircle
---

**Scenario.** A Telegram bot that answers questions with web search. DM it,
or mention it in a group, and it shows typing, posts a one-line status per
tool call, then streams its answer into a single message. Every chat gets
its own loop and its own history.

The [agentic loop](/recipes/agentic-loop/) already does the hard part:
wait for input at clean turn boundaries, batch bursts, run tools, keep
history. This recipe swaps its two ends. Instead of stdin, the queue is fed
by addressed messages from the chat; instead of stdout, the answer goes back
as one progressively edited message.

## The Design Move

The loop never learns it is talking to Telegram. It yields the generic
`Messenger` tag, and the chat it answers in is ambient:

```ts
conversation(inbox, options).pipe(inConversation(ref), Effect.forkScoped)
```

`inConversation(ref)` is set once, where a conversation's fiber starts.
Every `post`, `typing` and `stream` below it, including a tool reporting
progress from inside `Toolkit.run`, lands in that chat without a chat id
threaded through the loop. Swap the provider layer and the same file runs
on Slack or Discord.

## Per turn

Each iteration holds the typing indicator and a delivery fiber in its own
scope:

```ts
yield * messenger.typing
const deltas = yield * Queue.unbounded<string, Cause.Done>()
const delivery = yield * Effect.forkScoped(messenger.stream(Stream.fromQueue(deltas)))
```

Text deltas from the turn go into the queue and appear in the chat as the
model writes; a `ToolCallStart` becomes a short status post. When the turn
completes, the queue is ended and the delivery joined, so the final edit
lands before the loop moves on. A turn that only called tools posts nothing.
When the iteration ends, its scope releases the typing indicator.

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

The first addressed message in a chat creates its inbox and forks its loop.
Unaddressed group chatter never reaches a model. A conversation that dies
logs its cause; the router and every other chat keep going.

## Formatting is the prompt's job

Text is sent as written. The system prompt asks for Telegram HTML because
the wired layer sends it under `parse_mode: "HTML"`; on Slack the same line
would ask for markdown. If the model slips, the adapter resends that
message plain.

## Run it

Create a bot with [@BotFather](https://t.me/BotFather), then:

```sh
TELEGRAM_BOT_TOKEN=123:abc EXA_API_KEY=... OPENAI_API_KEY=... \
  pnpm tsx recipes/messenger-agent/run.ts
```

`--model provider:model`, `--search exa | perplexity | tavily` and
`--base-url` pick the backends. DM the bot and ask it something. For group
mentions, turn privacy mode off in BotFather (`/setprivacy`) or make the bot
an admin; with it on, Telegram only delivers commands, replies and DMs.

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/messenger-agent/recipe.ts).
