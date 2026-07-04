# effect-uai + AI SDK (Next.js)

A Next.js App Router chat app whose frontend is the stock `@ai-sdk/react`
`useChat` client, served by an effect-uai backend instead of `streamText`. The
point of the example is the one file that changes when you migrate:
[`app/api/chat/route.ts`](app/api/chat/route.ts).

That one file also shows what effect-uai gives you around the model:

- an **agentic tool loop** (a keyless [Open-Meteo](https://open-meteo.com)
  weather tool) rendered as tool cards on the client;
- **realistic model fallback** (primary → secondary on retryable failures);
- **live throughput metrics** (tok/s + time-to-first-token) streamed as AI SDK
  `data-metrics` parts, with settled token usage as message metadata;
- **structured mid-stream abort**: the client's Stop button aborts the
  request, and effect-uai interrupts the loop and drops the provider call.

The frontend consumes all of it through stock `useChat` features (`message.parts`,
`onData`, `message.metadata`, `stop()`) — no effect-uai on the client.

## The only file that changes

A typical AI SDK route handler:

```ts
import { openai } from "@ai-sdk/openai"
import { convertToModelMessages, streamText } from "ai"

export async function POST(req: Request) {
  const { messages } = await req.json()
  const result = streamText({
    model: openai("gpt-4o"),
    messages: convertToModelMessages(messages),
  })
  return result.toUIMessageStreamResponse()
}
```

The effect-uai equivalent (`convertToModelMessages` → `decodeMessages`,
`streamText` → an effect-uai loop, `toUIMessageStreamResponse` →
`toUIMessageStream` + `SSE.toBytes`):

```ts
const events = agent(Messages.decodeMessages(messages)).pipe(Stream.provide(provider))

const body = events.pipe(
  UIMessageStream.toUIMessageStream(crypto.randomUUID()),
  SSE.toBytes,
  Stream.toReadableStream,
)
return new Response(body, { headers: UIMessageStream.responseHeaders })
```

[`app/page.tsx`](app/page.tsx) is unchanged from any AI SDK app: the same
`useChat` hook, the same message `parts`. Swapping the backend does not touch
the frontend.

## Run it

This example is fully isolated: it has its own pnpm workspace root, so a
repo-wide `pnpm install` never pulls its Next.js dependency tree. Build the
local packages once, then install and run from this folder:

```sh
# from the repo root: build the linked packages so their dist/ exists
pnpm build

# from this folder
cd examples/ai-sdk-next
cp .env.example .env   # add your OPENAI_API_KEY
pnpm install
pnpm dev
```

Open http://localhost:3000 and chat. Change providers by swapping the one
`provider` layer in the route handler; change models via the `model` field on
`streamTurn`.

### Local-monorepo artifacts

Because this example consumes the effect-uai packages from the monorepo via
`link:` (rather than the registry), two settings exist only to make that work,
and a copy of the example using published `@effect-uai/*` packages should
remove both:

- `effect` is linked to the monorepo's copy so the app and the linked packages
  share one instance (`link:` bypasses pnpm's peer resolution, which would
  otherwise give two `effect` copies and break `Redacted`). Published packages
  share `effect` through their `peerDependencies` automatically.
- `turbopack.root` in `next.config.mjs` points at the repo so Turbopack follows
  the `../../` symlinks.
