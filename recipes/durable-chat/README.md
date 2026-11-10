---
title: Durable chat
description: A chat that survives a page reload. Answers keep going on the server, messages queue, and the browser re-opens the whole conversation.
source: recipes/durable-chat
icon: PiArrowsClockwise
---

Your user reloads the page halfway through a long answer, or their phone
drops the connection. In a plain chat route the answer dies with the
request. Here the whole chat lives on the server: the answer keeps going,
and the browser re-opens the conversation and continues from where it was.
Messages sent while an answer is still streaming are not refused; they queue
and get one answer together. Stop is an explicit button, never a side effect
of a dropped connection.

## The idea

A chat is one event stream that carries every run. A server-owned worker
answers the chat's inbox, a burst at a time, and publishes each run's events
to a `PubSub` with replay. Every reader, first or after a reload, gets the
whole chat so far and then the live tail.

```ts
Effect.forever(
  Settle.drainBurst(inbox, "300 millis").pipe(
    Effect.flatMap((batch) =>
      agent([...history, ...batch.flatMap((input) => input.messages)]).pipe(
        Projection.toRunEvents({ contract: ChatUi }), // ChatUi = UiContract.make({}): no tools
        Stream.catchCause((cause) => Stream.succeed(Run.failed(cause))),
        Run.stopWhen(Deferred.await(stop)),
        Run.start({ runId, inputs: batch.map((i) => i.id) }),
        Run.complete,
        Stream.runForEach((event) => chat.publish(event, runId)),
      ),
    ),
  ),
)
```

Stop completes the `Deferred`; `Run.stopWhen` ends the run with
`run-stopped` and the worker moves on to the next batch.

The server owns the history, so every answer sees the conversation before
it. Each message is echoed on the stream as soon as it is queued
(`input-accepted`), so a reloaded page shows it even before its answer starts.

The page is plain DOM over `@effect-uai/ui`: `Atoms.sessionThread` with
`Transport.sessionHttp`, which sends messages and follows the chat's stream.
It keeps the chat id in `localStorage` and re-opens it on load.

## Run it

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/durable-chat/run.ts
```

Open `http://localhost:3000`. Ask for something long, send a couple more
messages while it answers, then reload the page. **Clear** starts a new chat.

The same routes without the page:

```sh
curl -s -X POST localhost:3000/chats/messages -H 'content-type: application/json' \
  -d '{"input":{"id":"in_1","kind":"submit","messages":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Write a haiku about Lisbon."}]}]}}'
# {"chatId":"7f3c…"}

curl -N localhost:3000/chats/7f3c…/events          # the whole chat, then live
curl -N localhost:3000/chats/7f3c…/events?after=3  # only what came after event 3
curl -X POST localhost:3000/chats/7f3c…/stop       # stop the running answer
```

Send `"chatId"` in the body to add a message to an existing chat.

One process, in memory. For several instances or surviving restarts, swap
the `PubSub` and history for your database.
