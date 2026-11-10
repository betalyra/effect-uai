---
title: Direct chat
description: A chat page where each message is one request and its response is the answer. The server remembers the conversation.
source: recipes/direct-chat
icon: PiChatCircle
---

The simplest chat that is still a real one: your user types a message, the
browser posts it, and the response streams the answer back. The server keeps
the conversation, so the page never sends the history and never sees what
it should not (encrypted reasoning, provider signatures). Stop aborts the
request, and the server stops the model with it.

## The idea

The server answers one message with one run, and names the chat with the
run's stream id. The browser keeps that id in its `Thread` and sends it back
with the next message.

```ts
const send = (chatId: Option<StreamId>, input: Input.Submit) =>
  Effect.gen(function* () {
    const chat = yield* Option.match(chatId, { onNone: () => create, onSome: find })
    const history = yield* Ref.updateAndGet(chat.history, (h) => [...h, ...input.messages])
    return agent(history).pipe(
      Projection.toRunEvents({ contract: ChatUi }), // ChatUi = UiContract.make({}): no tools
      Stream.catchCause((cause) => Stream.succeed(Run.failed(cause))),
      Run.start({ runId, inputs: [input.id] }),
      Run.complete,
      Run.sequence(chat.id, { from: yield* Ref.get(chat.lastSeq) }),
    )
  })
```

Each `Run` operator does one thing: `failed` turns an error into
`run-failed`, `start` puts `run-started` first, `complete` ends the run with
`run-completed` unless it already ended, and `sequence` numbers the frames.
Leave one out or replace it with your own.

The route returns that stream as Server-Sent Events. The page is plain DOM
over `@effect-uai/ui`: `Atoms.thread` with `Transport.direct`.

```ts
const transport = Transport.direct({
  request: (input, thread: Thread.Thread) =>
    HttpClientRequest.post("/chat").pipe(
      HttpClientRequest.schemaBodyJson(ChatBody)(
        thread.streamId === null ? { input } : { chatId: thread.streamId, input },
      ),
    ),
})
const chat = Atoms.thread({
  runtime: Atom.runtime(Layer.mergeAll(FetchHttpClient.layer, SecureRandom.layerWebCrypto)),
  transport,
  busy: "block",
})
```

`SecureRandom` makes the input ids; a test gives it a seeded one.

A reload starts a new chat, and a dropped connection ends the answer. When
answers must survive both, use the [Durable chat](/recipes/durable-chat/).

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/direct-chat/run.ts
```

Open `http://localhost:3000` and chat.

The same route without the page:

```sh
curl -N -X POST localhost:3000/chat -H 'content-type: application/json' \
  -d '{"input":{"id":"in_1","kind":"submit","messages":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Write a haiku about Lisbon."}]}]}}'
# every frame carries "streamId": that is the chat id
```

Send `"chatId"` in the body to continue a chat. One process, in memory: swap
the history `Ref` for your database.
