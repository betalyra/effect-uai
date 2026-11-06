# effect-uai + Next.js

One Next.js app, the same tools, two ways to put a chat in front of them:

- **`/`: keep `useChat`.** The stock `@ai-sdk/react` client, served by an
  effect-uai loop instead of `streamText`. Only the route handler changes:
  [`app/api/chat/route.ts`](app/api/chat/route.ts).
- **`/ui`: `@effect-uai/ui`.** The server keeps the history, the page sends
  only the new message, and tool results arrive typed (a `Date` is a `Date`):
  [`lib/ui-server.ts`](lib/ui-server.ts) (an Effect `HttpRouter` route served
  through `HttpRouter.toWebHandler`), [`lib/ui-chat.ts`](lib/ui-chat.ts) (the
  atoms) and [`app/ui/page.tsx`](app/ui/page.tsx).

Both build their tools from [`lib/chat-ui.ts`](lib/chat-ui.ts), Schemas only,
so the browser can import them.

## `/`: the `useChat` route

The route also shows what effect-uai gives you around the model:

- an **agentic tool loop** (weather from keyless [Open-Meteo](https://open-meteo.com),
  and the date) rendered as tool cards on the client;
- **realistic model fallback** (primary → secondary on retryable failures);
- **live throughput metrics** (tok/s + time-to-first-token) streamed as AI SDK
  `data-metrics` parts, with settled token usage as message metadata;
- **structured mid-stream abort**: the client's Stop button aborts the
  request, and effect-uai interrupts the loop and drops the provider call.

The frontend consumes all of it through stock `useChat` features (`message.parts`,
`onData`, `message.metadata`, `stop()`), with no effect-uai on the client.

### The only file that changes

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

## `/ui`: the `@effect-uai/ui` page

The Next.js route is one line; the server is a plain Effect route:

```ts
// app/api/ui/chat/route.ts
export const POST = (request: Request) => handler(request)

// lib/ui-server.ts
export const { handler } = HttpRouter.toWebHandler(ChatRoute.pipe(Layer.provide(...)))
```

The page reads `Atoms.thread` with `@effect/atom-react`. With
`contract: ChatUi`, narrowing a tool block by name gives the tool's own types:

```tsx
if (block.name === "get_weather" && block.output !== undefined)
  block.output.observedAt.toLocaleTimeString() // a Date, decoded on arrival
```

## Run it

This example is fully isolated: it has its own pnpm workspace root, so a
repo-wide `pnpm install` never pulls its Next.js dependency tree. Build the
local packages once, then install and run from this folder:

```sh
# from the repo root: build the linked packages so their dist/ exists
pnpm build

# from this folder
cd examples/next-chat
cp .env.example .env   # add your LLM_API_KEY
pnpm install
pnpm dev
```

Open http://localhost:3000 for `useChat`, http://localhost:3000/ui for
`@effect-uai/ui`.

### Choosing a provider

The provider is environment, not code. [`lib/model.ts`](lib/model.ts) is one
`Match` that returns a `LanguageModelService` plus the two model ids the
fallback loop steps through:

| Variable             | Default                                         |
| -------------------- | ----------------------------------------------- |
| `LLM_PROVIDER`       | `requesty` (or `openai`, `anthropic`, `google`) |
| `LLM_API_KEY`        | fallback for whichever key the provider wants   |
| `LLM_MODEL`          | per provider, see below                         |
| `LLM_FALLBACK_MODEL` | per provider, see below                         |
| `LLM_BASE_URL`       | the gateway's own endpoint                      |

| Provider    | Primary                      | Fallback                         |
| ----------- | ---------------------------- | -------------------------------- |
| `requesty`  | `vertex/gemini-3.8-flash@eu` | `tensorx/deepseek-v4-flash-0731` |
| `openai`    | `gpt-5.6-terra`              | `gpt-5.6-luna`                   |
| `anthropic` | `claude-haiku-4-5-20251001`  | `claude-sonnet-4-6`              |
| `google`    | `gemini-3-flash-preview`     | `gemini-2.5-flash`               |

Requesty and OpenAI are the same wire protocol, so they share the Responses
adapter and differ only in base URL and key. `LLM_BASE_URL` overrides either,
which is also how you point at OpenRouter or any other OpenAI-compatible
gateway.

The app has a tool, so a model that cannot complete a function-call turn fails
the whole request with `IncompleteTurn`. Not every cheap gateway route can:
some stream the tool call and then drop the connection before sending
`response.completed`. Check a new default against the weather tool, not just
against plain chat.

Each provider reads its own key (`REQUESTY_API_KEY`, `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`) and falls back to `LLM_API_KEY`, so one
variable can drive the whole app.

```sh
# OpenAI direct
LLM_PROVIDER=openai

# Claude
LLM_PROVIDER=anthropic
```

The two models are the fallback demo: the primary is tried first, and a
retryable failure advances to the second on the same history.

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
