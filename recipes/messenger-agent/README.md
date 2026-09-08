---
title: Messenger agent
description: Put the agent where people already are. Mention it in Telegram or Discord; it types, searches the web, draws pictures, and streams the answer into one message. One loop and one history per conversation.
source: recipes/messenger-agent
icon: PiChatsCircle
---

**Scenario.** A Telegram or Discord bot that answers questions with web
search and draws on request. DM it, or mention it in a group, and it shows
typing, posts a one-line status per tool call, then streams its answer into
a single message. Ask for a picture and the picture arrives in the chat
before the model has said a word. Every chat gets its own loop and its own
history, and each tool is only there if you configured its provider.

The [agentic loop](/recipes/agentic-loop/) already does the hard part:
wait for input at clean turn boundaries, batch bursts, run tools, keep
history. This recipe swaps its two ends. Instead of stdin, the inbox is fed
by addressed messages from the chat; instead of stdout, the answer goes back
as one progressively edited message.

## The Design Move

The loop never learns which platform it is talking to. It yields the generic
`Messenger` tag, and the chat it answers in is ambient:

```ts
conversation(inbox, options).pipe(inConversation(ref), Effect.forkScoped)
```

`inConversation(ref)` is set once, where a conversation's fiber starts.
Every `post`, `typing` and `stream` below it lands in that chat without a
chat id threaded through the loop. The image tool is the proof: it runs
inside `Toolkit.run`, deep under the loop, and posts the picture itself.

```ts
run: ({ prompt }) =>
  Effect.gen(function* () {
    const messenger = yield* Messenger
    const { images } = yield* ImageGenerator.generate({ prompt, model })
    yield* Effect.forEach(images, ({ image }) => messenger.post(media(image)))
    return "Sent."
  }),
```

The model never sees the bytes, only "Sent.", and the tool never sees a
chat id. `--messenger discord` swaps the provider layer and this file, the
loop and the router are untouched.

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

`react` is the exception: it needs no provider, but it does need the id of
this conversation's last message, which a shared toolkit cannot hold. So it
is built per conversation:

```ts
const lastMessage = yield * Ref.make(Option.none<MessageId>())
const tools = Toolkit.fromArray([...Object.values(options.toolkit), reactTool(lastMessage)])
```

`post` and `typing` ride the ambient conversation; `react` names a message
outright, which is the whole difference.

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
lands before the loop moves on. A turn that only called tools streams no
text, and `stream` posts nothing for it. When the iteration ends, its scope
releases the typing indicator.

Input comes from `Inbox.drainBurst`: block for the first message, then keep
taking while the next arrives within the settle window, so three quick
lines become one user turn.

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

The first addressed message in a chat creates its inbox and forks its loop.
Unaddressed group chatter never reaches a model. A conversation that dies
logs its cause; the router and every other chat keep going.

The two lookups are the difference between starting a conversation and
joining one. `inboxFor` creates the inbox and forks the loop; `openInbox`
only finds an existing one, so an emoji is a turn in a chat already talking
and nothing at all in a quiet channel. It arrives as `[reacted 🤔]`, an
ordinary line of user input, so the loop never learns reactions exist.

## Formatting is the prompt's job

Text is sent as written, so the platform's markup is the prompt's business.
`--messenger` picks both at once: one entry holds the layer and the markup
it reads, and Betty is built from that.

```ts
const platforms: Record<string, Effect.Effect<Wiring, Config.ConfigError>> = {
  telegram: Effect.map(Config.redacted("TELEGRAM_BOT_TOKEN"), (token) => ({
    layer: telegramLayer({ token }),
    markup: "html",
  })),
  discord: Effect.map(Config.redacted("DISCORD_BOT_TOKEN"), (token) => ({
    layer: discordLayer({ token }),
    markup: "markdown",
  })),
}
```

Only the chosen platform's token is read, so running on Discord needs no
Telegram credentials. The persona's formatting sentence, its greeting and
the tool status line all follow the markup; the loop and the router do not
know which platform they are on.

## Run it

On Telegram, create a bot with [@BotFather](https://t.me/BotFather):

```sh
TELEGRAM_BOT_TOKEN=123:abc OPENAI_API_KEY=... EXA_API_KEY=... FAL_API_KEY=... \
  pnpm tsx recipes/messenger-agent/run.ts --search exa --image fal:fal-ai/flux/schnell
```

On Discord, create an app in the
[developer portal](https://discord.com/developers/applications), copy the bot
token, and invite it with the `bot` scope:

```sh
DISCORD_BOT_TOKEN=... OPENAI_API_KEY=... EXA_API_KEY=... \
  pnpm tsx recipes/messenger-agent/run.ts --messenger discord --search exa
```

`--model provider:model` and `--base-url` pick the model. `--search exa |
perplexity | tavily` and `--image provider:model` switch the tools on; both
are optional. DM the bot and ask it something, or ask it to draw something.

For group mentions on Telegram, turn privacy mode off in BotFather
(`/setprivacy`) or make the bot an admin; with it on, Telegram only delivers
commands, replies and DMs. `/start` is the only command this recipe handles,
and Discord has no commands at all, so a conversation there starts on the
first DM or mention.

On Discord, mention the bot from the `@` autocomplete under **MEMBERS**: the
identically named role above it is a role ping and does not address it. Add
`--read-all` for the privileged Message Content intent, which lets a plain
reply reach the bot without a mention.

`LOG_LEVEL=Debug` logs every inbound event with its conversation and
`addressed` flag, plus each turn and tool call, which is where to look when a
chat stays silent.

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/messenger-agent/recipe.ts).
