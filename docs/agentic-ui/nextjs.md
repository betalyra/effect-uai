---
title: Next.js
description: "Two ways to put effect-uai behind a Next.js chat: keep your useChat page, or move to @effect-uai/ui for history on the server and typed tool results."
source: examples/next-chat
icon: PiChatCircleDots
---

You have a Next.js app and want effect-uai behind its chat. There are two
ways, and the example app runs both side by side over the same tools.

| Keep `useChat` (`/`)                     | `@effect-uai/ui` (`/ui`)                          |
| ---------------------------------------- | ------------------------------------------------- |
| Your page doesn't change                 | A small client page over atoms                    |
| The client sends the whole history       | The server keeps it; the client sends one message |
| Tool outputs are JSON                    | Tool outputs are typed (a `Date` is a `Date`)     |
| Route speaks the AI SDK stream protocol  | Route is a plain Effect `HttpRouter` route        |

Start with `useChat` if you have it. Move when you need the right column.

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

## Use `@effect-uai/ui`

The route hands its `Request` to an Effect route:

```ts
// app/api/ui/chat/route.ts
export const POST = (request: Request) => handler(request)

// lib/ui-server.ts
export const { handler } = HttpRouter.toWebHandler(ChatRoute.pipe(Layer.provide(...)))
```

`ChatRoute` is the same route as on [TanStack Start](/agentic-ui/tanstack-start/).

The page is a client component over atoms:

```tsx
"use client"

export default function Page() {
  const thread = useAtomValue(chat.state)
  const submit = useAtomSet(chat.submit)
  // thread.messages, thread.active: plain data to render
}
```

`chat` is `Atoms.thread({ contract: ChatUi, ... })` in `lib/ui-chat.ts`,
module scope, so the state survives client-side navigation.

## Run it

```sh
cd examples/next-chat
cp .env.example .env   # add your key
pnpm install
pnpm dev
```

Open `/` for `useChat` and `/ui` for `@effect-uai/ui`.
