---
title: TanStack Start
description: "A TanStack Start server route that hands its Request to an Effect route, and a React page that reads the chat from atoms."
source: examples/tanstack-start-chat
icon: PiChatCircleDots
---

The server route is one line. Behind it is a plain Effect `HttpRouter`
route, so the agent, the chat store and the SSE stream are the same code you
would run on any Effect server.

## Server

```ts
// src/routes/api/chat.ts
export const Route = createFileRoute("/api/chat")({
  server: { handlers: { POST: ({ request }) => handler(request) } },
})
```

```ts
// src/server/chat.ts
const ChatRoute = Layer.unwrap(
  Effect.gen(function* () {
    const chats = yield* makeChats
    return HttpRouter.add(
      "POST",
      "/api/chat",
      HttpServerRequest.schemaBodyJson(ChatBody).pipe(
        Effect.flatMap(({ chatId, input }) => chats.send(Option.fromNullishOr(chatId), input)),
        Effect.map((run) =>
          HttpServerResponse.stream(run.pipe(SseEncoding.encode), {
            headers: SseEncoding.responseHeaders,
          }),
        ),
      ),
    )
  }),
)

export const { handler } = HttpRouter.toWebHandler(ChatRoute.pipe(Layer.provide(...)))
```

`toWebHandler` builds the layer once per server process. When the browser
aborts the request, the run is interrupted. `chats.send` is the
[server pipeline](/agentic-ui/#on-the-server) with the history in a `Ref`.

## Client

```ts
// src/chat.ts
export const chat = Atoms.thread({
  contract: ChatUi,
  runtime: Atom.runtime(Layer.mergeAll(FetchHttpClient.layer, SecureRandom.layerWebCrypto)),
  transport,
  busy: "block",
})
```

```tsx
// src/routes/index.tsx
const thread = useAtomValue(chat.state)
const submit = useAtomSet(chat.submit)
const stop = useAtomSet(chat.stop)
```

`thread.messages` are the settled turns, `thread.active` the run that is
streaming. With `contract: ChatUi` a tool block narrowed by name has its
tool's types on `partial` and `outcome`, a `Date` included.

## Run it

```sh
cd examples/tanstack-start-chat
pnpm install
OPENAI_API_KEY=sk-... pnpm dev
```

Open http://localhost:4310.
