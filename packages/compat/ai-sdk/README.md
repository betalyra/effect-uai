# @effect-uai/ai-sdk

Vercel AI SDK compatibility for effect-uai. Keep your `@ai-sdk/react`
`useChat` frontend exactly as it is and serve it from an effect-uai agent
loop instead of `streamText`.

Two functions bridge the two worlds:

- `Messages.decodeMessages` turns the `UIMessage[]` a `useChat` client POSTs
  into effect-uai `HistoryItem`s.
- `UIMessageStream.toUIMessageStream` projects the loop's `InteractionEvent`
  stream onto the AI SDK UI Message Stream protocol (`v1`), emitting
  `SSE.Event`s.

The package owns no HTTP layer: it produces a `Stream<SSE.Event>` and the
required `responseHeaders`, so it drops into any server.

## Install

```sh
pnpm add @effect-uai/ai-sdk
```

## A chat route

`decodeMessages` in, run your loop, `toUIMessageStream` out. Provide your
provider layer so the stream has no remaining requirements, then hand the
bytes to whatever server you run.

```ts
import * as Messages from "@effect-uai/ai-sdk/Messages"
import * as UIMessageStream from "@effect-uai/ai-sdk/UIMessageStream"
import * as SSE from "@effect-uai/core/SSE"
import { Stream } from "effect"

export async function POST(request: Request): Promise<Response> {
  const { messages } = await request.json()
  const history = Messages.decodeMessages(messages)

  const events = agent(history).pipe(Stream.provide(OpenAILayer)) // your loop, unchanged

  const body = events.pipe(
    UIMessageStream.toUIMessageStream(crypto.randomUUID()),
    SSE.toBytes,
    Stream.toReadableStream,
  )
  return new Response(body, { headers: UIMessageStream.responseHeaders })
}
```

### With `@effect/platform`

Same stream, wrapped in an `HttpServerResponse` instead of a web `Response`:

```ts
import { HttpServerResponse } from "@effect/platform"

const body = events.pipe(UIMessageStream.toUIMessageStream(id), SSE.toBytes)
return HttpServerResponse.stream(body, { headers: UIMessageStream.responseHeaders })
```

## Coverage

Outbound, text and reasoning deltas, tool calls (input streaming plus
resolved output), and refusals map to their protocol parts. Alongside the
loop's `InteractionEvent`s, `toUIMessageStream` also accepts `dataPart` and
`messageMetadata` emissions, so callers can interleave custom typed data
(`data-<name>`, optionally `transient`) and settled per-message metadata:

```ts
events.pipe(
  Stream.map((e) => (Metrics.isThroughput(e) ? dataPart("metrics", e, { transient: true }) : e)),
  UIMessageStream.toUIMessageStream(id),
)
```

Inbound, `decodeMessages` reconstructs text, image (`file` with an `image/*`
media type), and tool parts: an assistant tool call becomes a `function_call`
item plus a `function_call_output` once the client carries its result.
Non-image files and unresolved tool states are dropped.
