# effect-uai + FoldKit

A chat in [FoldKit](https://foldkit.dev) (the Elm architecture on Effect) over
`@effect-uai/ui`. No atoms and no framework adapter: FoldKit owns the state,
`@effect-uai/ui` supplies the fold and the transport.

- The chat is a `Thread` inside the Model, and `Thread.step` runs inside
  `update` for every envelope.
- The open request is a Subscription keyed on the input in flight. Setting it
  sends the message; clearing it (Stop) tears the stream down, which aborts the
  request, and the server stops the model.
- The input id is random, so a Command creates it; `update` stays pure.

[`server.ts`](server.ts) is the backend: one Effect `HttpServer` route,
`POST /api/chat`, that answers each message with the run as Server-Sent
Events and keeps the history. The chat id is the envelopes' `streamId`, so the
page learns it from the first answer and sends it back.

## Run it

Build the linked packages once from the repo root (`pnpm build`), then:

```sh
cd examples/foldkit-chat
pnpm install
OPENAI_API_KEY=sk-... pnpm dev
```

`pnpm dev` starts the server on :3001 and Vite on :5173, which proxies `/api`
to the server. Open http://localhost:5173.

The packages come from the monorepo via `link:`, and `effect` is linked to the
monorepo's copy so everything shares one instance. A copy using published
`@effect-uai/*` packages drops both.
