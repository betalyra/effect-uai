---
title: Messenger agent
description: Put the agent where people already are. Mention it in Telegram, Discord or Slack; it types, searches the web, draws pictures, and streams the answer into one message. One loop and one history per conversation.
source: recipes/messenger-agent
icon: PiAt
---

**Scenario.** You want your agent in the chat your users already have open.
DM it or mention it, and it shows typing, posts a one-line status per tool
call, then streams its answer into a single message. Ask for a picture and
the picture lands in the chat before the model says a word. Every chat gets
its own loop and its own history, and the same program runs on Telegram,
Discord or Slack behind a `--messenger` flag.

The [agentic loop](/recipes/agentic-loop/) already does the hard part: wait
for input at clean turn boundaries, batch bursts, run tools, keep history.
This recipe swaps its two ends. The inbox is fed by addressed messages from
the chat instead of stdin, and the answer goes back as one progressively
edited message instead of stdout.

## The Design Move

The loop never learns which platform it is on. It yields the generic
`Messenger` tag, and the chat it answers in is ambient:

```ts
conversation(inbox, options).pipe(inConversation(ref), Effect.forkScoped)
```

`inConversation(ref)` is set once, where a conversation's fiber starts.
Every `post`, `typing` and `stream` below it lands in that chat without a
chat id threaded through the loop. The image tool shows what that buys: it
runs inside `Toolkit.run`, deep under the loop, and posts the picture itself.

```ts
run: ({ prompt }) =>
  Effect.gen(function* () {
    const messenger = yield* Messenger
    const { images } = yield* ImageGenerator.generate({ prompt, model })
    yield* Effect.forEach(images, ({ image }) => messenger.post(media(image)))
    return "Sent."
  }),
```

The model only hears "Sent.", the tool never sees a chat id, and switching
platforms changes nothing here.

## Tools are configuration

`--search exa` and `--image fal:fal-ai/flux/schnell` each produce one value
holding the tool and the layer that serves it:

```ts
const image = Option.map(flagValue("image", argv), (spec) => {
  const drawing = parseModelSpec(spec, "openai")
  return { tool: imageTool(drawing.model), layer: imageGeneratorLayer(drawing) }
})
const configured = Arr.getSomes([search, image])
```

The toolkit is `Toolkit.fromArray` over the present tools and the layers are
spread into `Layer.mergeAll`, so a tool and its provider cannot drift apart.
Leave a flag out and the model is never offered that tool.

`react` is built per conversation instead: it needs no provider, but it
needs the id of this conversation's last message, which a shared toolkit
cannot hold.

```ts
const lastMessage = yield * Ref.make(Option.none<MessageId>())
const tools = Toolkit.fromArray([...Object.values(options.toolkit), reactTool(lastMessage)])
```

## Per turn

Each iteration holds the typing indicator and a delivery fiber in its own
scope:

```ts
yield * messenger.typing
const deltas = yield * Queue.unbounded<string, Cause.Done>()
const delivery = yield * Effect.forkScoped(messenger.stream(Stream.fromQueue(deltas)))
```

Text deltas go into the queue and appear in the chat as the model writes; a
`ToolCallStart` becomes a short status post. When the turn completes, the
queue is ended and the delivery joined, so the final edit lands before the
loop moves on. A turn that only called tools streams no text and posts
nothing. When the iteration ends, its scope releases the typing indicator.

Input comes from `Inbox.drainBurst`: block for the first message, then keep
taking while the next arrives within the settle window, so three quick lines
become one user turn.

## Router

```ts
yield *
  Stream.runForEach(messenger.events, (event) =>
    Match.value(event).pipe(
      Match.when({ _tag: "Message", addressed: true }, (message) =>
        Effect.flatMap(inboxFor(message.conversation), (inbox) =>
          Queue.offer(inbox, { text: message.text, id: message.id }),
        ),
      ),
      Match.when({ _tag: "Reaction" }, (reaction) =>
        Effect.flatMap(
          openInbox(reaction.conversation),
          Option.match({
            onNone: () => Effect.void,
            onSome: (inbox) =>
              Queue.offer(inbox, { text: `[reacted ${reaction.emoji}]`, id: reaction.message }),
          }),
        ),
      ),
      Match.when({ _tag: "Command", name: "start" }, (command) =>
        messenger.post(text(greeting)).pipe(inConversation(command.conversation)),
      ),
      Match.orElse(() => Effect.void),
    ),
  )
```

The first addressed message in a chat creates its inbox and forks its loop;
unaddressed group chatter never reaches a model. `inboxFor` starts a
conversation, `openInbox` only joins one, so a reaction is a turn in a chat
already talking and nothing in a quiet channel. It arrives as
`[reacted 🤔]`, an ordinary line of input, so the loop never learns
reactions exist. A conversation that dies logs its cause; the router and
every other chat keep going.

## Formatting is the prompt's job

Text is sent as written, so the platform's markup is the prompt's business.
`--messenger` picks the layer and the markup together, and the persona's
formatting sentence, greeting and status line follow the markup:

```ts
const platforms = {
  telegram: Effect.map(Config.redacted("TELEGRAM_BOT_TOKEN"), (token) => ({
    layer: telegramLayer({ token }),
    markup: "html",
  })),
  discord: Effect.map(Config.redacted("DISCORD_BOT_TOKEN"), (token) => ({
    layer: discordLayer({ token }),
    markup: "markdown",
  })),
  slack: Effect.map(
    Effect.all({
      botToken: Config.redacted("SLACK_BOT_TOKEN"),
      appToken: Config.redacted("SLACK_APP_TOKEN"),
    }),
    (tokens) => ({ layer: slackLayer(tokens), markup: "markdown" }),
  ),
}
```

Only the chosen platform's tokens are read.

## Run it

Set the bot up on the platform's page first:
[Telegram](/messenger/providers/telegram/),
[Discord](/messenger/providers/discord/) or
[Slack](/messenger/providers/slack/). Then:

```sh
# Telegram
TELEGRAM_BOT_TOKEN=123:abc OPENAI_API_KEY=... EXA_API_KEY=... FAL_API_KEY=... \
  pnpm tsx recipes/messenger-agent/run.ts --search exa --image fal:fal-ai/flux/schnell

# Discord
DISCORD_BOT_TOKEN=... OPENAI_API_KEY=... EXA_API_KEY=... \
  pnpm tsx recipes/messenger-agent/run.ts --messenger discord --search exa

# Slack
SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... OPENAI_API_KEY=... EXA_API_KEY=... \
  pnpm tsx recipes/messenger-agent/run.ts --messenger slack --search exa
```

`--model provider:model` and `--base-url` pick the model. `--search exa |
perplexity | tavily` and `--image provider:model` switch the tools on; both
are optional. DM the bot and ask it something, or ask it to draw.

What to expect per platform:

- **Telegram**: `/start` greets. For group mentions, turn privacy mode off
  in BotFather or make the bot an admin.
- **Discord**: no commands; the first DM or mention starts a conversation.
  Mention the bot from the `@` autocomplete under **MEMBERS**, not the role
  of the same name. `--read-all` requests the Message Content intent so a
  plain reply reaches it without a mention.
- **Slack**: `/start` greets. Mention the bot in a channel and it answers in
  a thread; inside that thread, mention it again for a follow-up.

`LOG_LEVEL=Debug` logs every inbound event with its conversation and
`addressed` flag, plus each turn and tool call, which is where to look when
a chat stays silent.

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/messenger-agent/recipe.ts).
