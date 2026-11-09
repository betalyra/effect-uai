---
title: Agentic UI
description: "Stream your agent's runs to the browser: text, tool calls and objects as plain state, typed end to end, surviving reloads when you need it."
icon: PiChatCircleDots
---

Your agent runs on the server. Your user wants to watch it think, call tools
and answer, in a browser that reloads, drops connections and hits Stop.
`@effect-uai/ui` is the part in between: a small wire protocol the server
streams, and folds that turn it into plain state your framework renders.
No components, no hooks you can't read.

```sh
pnpm add @effect-uai/ui
```

## On the server

Project your loop onto run events, frame the run, number the frames, send
them as SSE:

```ts
import * as Projection from "@effect-uai/ui/Projection"
import * as Run from "@effect-uai/ui/Run"
import * as SseEncoding from "@effect-uai/ui/SseEncoding"

const body = agent(history).pipe(
  Projection.toRunEvents({ contract: ChatUi }),
  Stream.catchCause((cause) => Stream.succeed(Run.failed(cause))),
  Run.start({ runId, inputs: [input.id] }),
  Run.complete,
  Run.sequence(chatId),
  SseEncoding.encode,
)
return HttpServerResponse.stream(body, { headers: SseEncoding.responseHeaders })
```

Each `Run` operator does one job, and together they keep one rule: a run
starts with `run-started` and ends with exactly one terminal. `failed` is
where you decide what a failure tells the client (its tag by default, never
the message). `Run.stopWhen(signal)` adds a Stop button for runs that outlive
the request.

Keep the history on the server. The client sends only the new message; the
server appends it, and appends what the model says. The browser never needs
encrypted reasoning or provider signatures, so it never gets them.

## In the browser

A transport says how to reach the server; atoms hold the state:

```ts
import * as Atoms from "@effect-uai/ui/Atoms"
import * as Input from "@effect-uai/ui/Input"
import * as Transport from "@effect-uai/ui/Transport"

const transport = Transport.direct({
  request: (input, thread: Thread.Thread) =>
    HttpClientRequest.post("/api/chat").pipe(
      HttpClientRequest.schemaBodyJson(ChatBody)({ chatId: thread.streamId, input }),
    ),
})

const chat = Atoms.thread({
  runtime: Atom.runtime(Layer.mergeAll(FetchHttpClient.layer, SecureRandom.layerWebCrypto)),
  transport,
  busy: "block",
})
```

`chat.state` is a `Thread`: the settled `messages`, the `active` run, and
inputs still `pending`. Each run is a `RunView` with ordered blocks (text,
reasoning, tool calls with their status, objects, images). React reads it with
`useAtomValue(chat.state)`; `chat.submit(Input.submit(text))` sends, and
`chat.stop()` aborts.

Not using atoms? `Thread` and `RunView` are pure folds (`initial` + `step`).
Run them in your own reducer, an Elm `update`, or `Stream.scan`.

## Typed tools

The wire carries JSON. To get your tool's real types back in the browser,
share a contract built from Schemas only:

```ts
// chat-ui.ts: imported by server and client
export class CityNotFound extends Schema.TaggedError<CityNotFound>()("CityNotFound", {
  city: Schema.String,
}) {}

export const GetWeather = {
  name: "get_weather",
  description: "The weather right now in a city.",
  inputSchema: Schema.Struct({ city: Schema.String }),
  outputSchema: Schema.Struct({ temperatureC: Schema.Number, observedAt: Schema.DateFromString }),
  // Gated by approval: the app may close a call with `Denied`.
  failureSchema: Schema.Union([CityNotFound, ToolDecision.Denied]),
} as const

export const ChatUi = UiContract.make({ tools: [GetWeather] })
```

The server builds the tool from the spec (`Tool.make({ ...GetWeather, run })`)
and passes the contract to `Projection.toRunEvents({ contract: ChatUi })`.
A tool's `failureSchema` lists every error its calls can end with, including
the ones the app closes calls with itself (`ToolDecision.Denied`); core's errors
are always included. The client passes
`contract: ChatUi` to `Atoms.thread`, and each envelope is decoded once on
arrival. A tool block carries the latest `partial` of a streaming tool and,
once the call ends, its `outcome`:

```ts
if (block.type === "tool" && block.name === "get_weather") {
  if (block.outcome?._tag === "Success") block.outcome.value.observedAt // Date, not a string
  if (block.outcome?._tag === "Failure") block.outcome.error // CityNotFound | core error | Denied
}
```

A tool the contract doesn't list still arrives, as a `Content.Value` (an image
arrives as a `Content.Image`). A listed tool whose payload doesn't decode fails
the stream: that's a contract bug, not data.

## Approvals

When your loop stops on a call that needs a human, it ends the run with
`run-interrupted` and the card shows `awaiting-approval`. The page sends the
answer as an input,
`chat.submit(Input.resolve([{ callId, decision: ToolDecision.Default.Approve() }]))`,
and your server decides: it takes the pending calls from its own history,
checks who may approve them, groups them with `ToolDecision.Default.resolve`, runs
the approved ones and closes the denied ones with `ToolDecision.Denied`. The result
updates the card it was asked from.

## Direct or durable

**Direct**: one request per message, the response is the run. Simple, and a
closed tab stops the model. A reload loses the answer in progress.

**Durable**: the run lives on the server and the browser follows a stream it
can re-open. A reload replays the chat and picks up the answer mid-sentence;
messages sent during an answer queue up. Use `Transport.sessionHttp` with
`Atoms.sessionThread`, and serve the stream from a store with replay.

Start direct. Switch when a lost answer costs your user something.

## Your framework

- [Next.js](/agentic-ui/nextjs/): keep `useChat`, or move to this package.
- [TanStack Start](/agentic-ui/tanstack-start/): a server route and React atoms.
- [FoldKit](/agentic-ui/foldkit/): Effect on both ends, the chat as a fold in
  your Model.
- No framework: [Direct chat](/recipes/direct-chat/) and
  [Durable chat](/recipes/durable-chat/) are plain DOM.
