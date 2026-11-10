---
title: FoldKit
description: "Effect on both ends: an Effect server, a FoldKit page, one set of Schemas between them. The chat is a fold in your Model, and Stop is a Model change."
source: examples/foldkit-chat
icon: PiChatCircleDots
---

[FoldKit](https://foldkit.dev) is the Elm architecture on Effect: a Model,
messages, a pure `update`, Commands and Subscriptions. effect-uai is Effect
on the server. Put them together and the whole app is one language: the same
Schemas define the tools on the server and type the state in your Model.

It also fits by shape. `@effect-uai/ui` gives you a chat as a fold
(`initial` + `step`), and a fold is exactly what `update` runs. No atoms, no
adapter.

## The contract

Tools as Schemas only, imported by server and page:

```ts
// src/chat-ui.ts
export const GetWeather = {
  name: "get_weather",
  description: "The weather right now in a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({
    city: Schema.String,
    temperatureC: Schema.Number,
    observedAt: Schema.DateFromString,
  }),
} as const

export const ChatUi = UiContract.make({ tools: [GetWeather, GetDate] })
```

The server builds its tools with `Tool.make({ ...GetWeather, run })` and
serves the run over an Effect `HttpRouter` route (`server.ts`). A tool whose
`run` returns a Stream (the example's `find_restaurants`) sends each element
as a typed `partial`, so its card fills in as results arrive.

## The Model holds the thread

```ts
const fold = Thread.presetFor<ChatPayloads>()

export const Model = Schema.Struct({
  prompt: Schema.String,
  thread: ChatUi.Thread,
  request: Schema.NullOr(Request), // the request in flight
})
```

`ChatUi.Thread` is a Schema of the thread typed by the contract, so the
Model stays a Schema, as FoldKit wants. `update` folds every envelope:

```ts
GotEnvelope: ({ envelope }) => ({
  model: { ...model, thread: fold.step(model.thread, envelope) },
}),
```

## The request is a Subscription

Sending sets `request`; a Subscription keyed on it streams the answer:

```ts
dependenciesToStream: ({ request }) =>
  request === null
    ? Stream.empty
    : transport.start(request.input, request.chatId).pipe(
        Stream.mapEffect(ChatUi.decode),
        Stream.map((envelope) => Message.GotEnvelope({ envelope })),
        Stream.catchCause(() => Stream.empty),
        Stream.concat(Stream.make(Message.EndedRequest())),
      ),
```

Stop sets `request: null`. FoldKit tears the stream down, the fetch is
aborted, and the server stops the model. Stop is a pure Model change, not an
imperative cancel.

The input id is random, so a Command creates it (`Input.withId`) and
`update` stays pure.

## In the view

Narrowing a tool block by name types its `partial` and `outcome` (a decoded
`Success` or a typed `Failure`):

```ts
if (block.name === "get_weather" && block.outcome?._tag === "Success") {
  const { city, temperatureC, observedAt } = block.outcome.value // observedAt: Date
}
```

## Run it

```sh
cd examples/foldkit-chat
pnpm install
OPENAI_API_KEY=sk-... pnpm dev
```

Open http://localhost:4320; the server runs on :4325 and Vite proxies `/api` to it.
