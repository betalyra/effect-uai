---
title: Coming from the AI SDK
description: How to move a Vercel AI SDK (useChat) backend to effect-uai without changing your frontend.
---

You have a `useChat` app and you want to run effect-uai behind it. Your
frontend stays exactly as it is: the hook, your components, the way you render
messages. The only file you rewrite is the route handler, because that is the
only place `streamText` lives. This is the same whether your `useChat` comes
from `@ai-sdk/react`, Svelte, Vue, or Angular: the adapter works at the
protocol level, not the framework level.

`@effect-uai/ai-sdk` speaks the AI SDK's UI Message Stream protocol (the `v1`
wire format, unchanged across AI SDK v5, v6, and v7), so the browser can't tell
the backend was swapped.

This page is about the AI SDK's **chat UI**. If you use the AI SDK's other
functions on the server (`generateObject`, `embed`, and so on), you don't need
a compat layer at all: see [the rest of the AI SDK](#the-rest-of-the-ai-sdk),
where each one maps onto an effect-uai primitive you call directly.

```sh
pnpm add @effect-uai/ai-sdk
```

## Your handler today

A typical `useChat` backend looks like this:

```ts
import { openai } from "@ai-sdk/openai"
import { convertToModelMessages, streamText } from "ai"

export async function POST(req: Request) {
  const { messages } = await req.json()
  const result = streamText({
    model: openai("gpt-4o"),
    system: "You are helpful.",
    messages: convertToModelMessages(messages),
    tools: { getWeather /* … */ },
  })
  return result.toUIMessageStreamResponse()
}
```

Three things happen: the request messages are converted, `streamText` runs the
model and any tools, and the result is streamed back in the format `useChat`
reads. Migrating is replacing each of those three with its effect-uai piece.

## The same handler, on effect-uai

```ts
import * as Messages from "@effect-uai/ai-sdk/Messages"
import * as UIMessageStream from "@effect-uai/ai-sdk/UIMessageStream"
import * as SSE from "@effect-uai/core/SSE"
import { Stream } from "effect"

export async function POST(request: Request): Promise<Response> {
  const { messages } = await request.json()

  // 1. incoming useChat messages -> effect-uai history
  const history = Messages.decodeMessages(messages)

  // 2. your loop (below), with the provider Layer provided in
  const events = agent(history).pipe(Stream.provide(OpenAILayer))

  // 3. loop events -> the format useChat reads
  const body = events.pipe(
    UIMessageStream.toUIMessageStream(crypto.randomUUID()),
    SSE.toBytes,
    Stream.toReadableStream,
  )
  return new Response(body, { headers: UIMessageStream.responseHeaders })
}
```

Same three steps: decode, run, encode. `convertToModelMessages` becomes
`decodeMessages`, `toUIMessageStreamResponse` becomes `toUIMessageStream`
plus `SSE.toBytes`, and the required protocol headers come from
`responseHeaders`. What actually changes is the middle: `streamText` was one
call that hid the loop, and now you write the loop.

Running `@effect/platform`'s `HttpServer` instead of a web `Response`? Feed the
same `SSE.toBytes` stream to `HttpServerResponse.stream(...)` with the same
`responseHeaders`. The package owns no HTTP layer, so it fits either way.

## The loop that replaces `streamText`

`streamText` with `tools` is an agent loop: call the model, run the tools it
asks for, feed the results back, repeat until it stops asking. effect-uai makes
that loop something you can read top to bottom instead of a set of callbacks:

```ts
import { loop, onTurnComplete, stop } from "@effect-uai/core/Loop"
import { LanguageModel } from "@effect-uai/core/LanguageModel"
import * as Toolkit from "@effect-uai/core/Toolkit"
import * as Turn from "@effect-uai/core/Turn"
import { Effect, pipe } from "effect"

const agent = (history: ReadonlyArray<HistoryItem>) =>
  pipe(
    { history },
    loop((state) =>
      Effect.gen(function* () {
        const lm = yield* LanguageModel
        return lm.streamTurn({ history: state.history, model: "gpt-5.4-mini", tools }).pipe(
          onTurnComplete((turn) =>
            Effect.sync(() => {
              const calls = Turn.getToolCalls(turn)
              if (calls.length === 0) return stop() // no tool calls -> answer is done
              return Toolkit.run(tools, calls).pipe(
                Toolkit.continueWithResults(Toolkit.appendToolResults(state, turn)),
              )
            }),
          ),
        )
      }),
    ),
  )
```

Your tools move from a plain object to `Tool.make` + `Toolkit.make`. That is
the one part with real API surface to learn; the [Tools and
toolkits](/language-models/tools/) page walks through it. Everything else in
the handler is glue.

## Where your `streamText` options go

The options you passed to `streamText` do not disappear. They become ordinary
code in and around the loop, which is the point: when a request goes sideways,
you debug a loop you wrote, not a lifecycle you patched from the outside.

| In `streamText(...)`              | In your loop                                                             |
| --------------------------------- | ------------------------------------------------------------------------ |
| `model: openai("gpt-4o")`         | the `model` on `streamTurn`, plus the provider `Layer` you provide       |
| `system: "…"`                     | an `Items.systemText(…)` at the front of the initial history             |
| `tools: { … }`                    | `Tool.make` + `Toolkit.make`, run in `onTurnComplete`                    |
| `stopWhen` / `maxSteps`           | your own check: return `stop()` (e.g. count turns in state)              |
| `maxRetries`                      | a retry `Schedule`, or a fallback tier list guarded by `Stream.catchTag` |
| `onError`                         | `Stream.catchTag` on typed failures (`RateLimited`, `Unavailable`, …)    |
| `messageMetadata` on the response | `UIMessageStream.messageMetadata(…)` emissions                           |
| the request `AbortSignal`         | `Stream.interruptWhen(…)` on `request.signal`                            |

Retry and fallback are worth calling out. In the AI SDK they are flags on the
call; in effect-uai they are data and control flow you can see. A fallback is a
list of tiers and a `catchTag` that advances to the next one, and it only
touches the loop body.

## Your frontend does not change

Everything the loop produces reaches the client through `useChat` features you
already use. Text, reasoning, and tool calls arrive as `message.parts`. Settled
usage lands on `message.metadata`. Anything custom you stream (live tok/s, a
status line, sources) arrives via `onData`, using `UIMessageStream.dataPart` on
the server. Cancellation is the client's existing `stop()`, which aborts the
request and, through structured concurrency, tears down the loop and drops the
provider call. None of this adds effect-uai to the browser.

## The rest of the AI SDK

The compat layer on this page exists because the chat UI is a wire protocol you
have to match. Everywhere else there is nothing to match: the AI SDK's
top-level functions each correspond to an effect-uai primitive you call
directly, and you drop the AI SDK on the server entirely. Find the function you
use and follow the link for the full version.

| AI SDK                                      | effect-uai equivalent                     |                                          |
| ------------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| `generateText` / `streamText` (server-side) | write the loop over `streamTurn`          | [Read more](/language-models/)           |
| `generateObject` / `streamObject`           | a turn decoded against an Effect `Schema` | [Read more](/recipes/structured-output/) |
| `tool(...)`                                 | `Tool.make` + `Toolkit.make`              | [Read more](/language-models/tools/)     |
| `embed` / `embedMany`                       | the `Embedding` model                     | [Read more](/embeddings/)                |
| `transcribe`                                | the `Transcriber` model                   | [Read more](/speech/transcription/)      |
| `generateSpeech`                            | the `SpeechSynthesizer` model             | [Read more](/speech/synthesis/)          |
| `generateImage`                             | an `ImageGenerator` tag                   | [Coming soon](/image-generation/)        |
| `rerank`                                    | a `Reranker` tag                          | [Coming soon](/reranking/)               |

The pattern is the same across the table: where the AI SDK gives you one
function with options, effect-uai gives you a service you resolve from a
`Layer` and drive explicitly. Switching provider stays a `Layer` swap in every
row.

## A full example

[`examples/ai-sdk-next`](https://github.com/betalyra/effect-uai/tree/main/examples/ai-sdk-next)
is a Next.js app that does exactly this: a stock `useChat` frontend and one
effect-uai route with a tool loop, model fallback, live metrics, and a working
Stop button. Its README has the line-by-line diff for the handler.
