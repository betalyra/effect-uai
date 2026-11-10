---
title: Next.js
description: "Put effect-uai behind a Next.js chat: @effect-uai/ui for history on the server, typed tool results and approvals, or keep your useChat page."
source: examples/next-chat
icon: PiChatCircleDots
---

You have a Next.js app and want effect-uai behind its chat. There are two
ways, and the example app runs both side by side over the same tools.

| `@effect-uai/ui` (`/`)                                 | Keep `useChat` (`/ai-sdk`)              |
| ------------------------------------------------------ | --------------------------------------- |
| A small client page over atoms                         | Your page doesn't change                |
| The server keeps history; the client sends one message | The client sends the whole history      |
| Tool outputs are typed (a `Date` is a `Date`)          | Tool outputs are JSON                   |
| Approvals, live metrics as typed `live` values         | Data parts and message metadata         |
| Route is a plain Effect `HttpRouter` route             | Route speaks the AI SDK stream protocol |

Already on `useChat`? Keep it, and move when you need the left column.

## Use `@effect-uai/ui`

The route hands its `Request` to an Effect route:

```ts
// app/api/ui/chat/route.ts
export const POST = (request: Request) => handler(request)

// lib/ui-server.ts
export const { handler } = HttpRouter.toWebHandler(ChatRoute.pipe(Layer.provide(...)))
```

`ChatRoute` is the same route as on [TanStack Start](/agentic-ui/tanstack-start/):
tools, the approval policy, metrics. `find_restaurants` returns a Stream; this
page shows its results as they arrive (typed `partial`), the `useChat` page
once the call settles.

The page is a client component over atoms:

```tsx
"use client"

export default function Page() {
  const thread = useAtomValue(chat.state)
  const submit = useAtomSet(chat.submit)
  // thread.messages, thread.active: plain data to render
}
```

`chat` is `Atoms.thread({ contract: ChatUi, ... })` in `lib/ui-chat.ts`, at
module scope, so the state survives client-side navigation. Answers render as
markdown with [Streamdown](https://github.com/vercel/streamdown), which copes
with half-written markdown while it streams.

## Keep `useChat`

Only the route handler changes: decode the AI SDK messages, run your loop,
encode the result in the AI SDK's stream format.

```ts
// app/api/chat/route.ts
export async function POST(request: Request): Promise<Response> {
  const { messages } = await request.json()
  const body = agent(Messages.decodeMessages(messages)).pipe(
    UIMessageStream.toUIMessageStream(crypto.randomUUID()),
    SSE.toBytes,
    Stream.toReadableStream,
  )
  return new Response(body, { headers: UIMessageStream.responseHeaders })
}
```

[Coming from the AI SDK](/coming-from/ai-sdk/) walks through it.

## Run it

```sh
cd examples/next-chat
cp .env.example .env   # add your key
pnpm install
pnpm dev
```

Open http://localhost:4330 for `@effect-uai/ui` and `/ai-sdk` for `useChat`.
