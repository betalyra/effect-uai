# effect-uai + FoldKit

A chat in [FoldKit](https://foldkit.dev) (the Elm architecture on Effect) over
`@effect-uai/ui`. No atoms and no framework adapter: FoldKit owns the state,
`@effect-uai/ui` supplies the fold and the transport.

- The chat is a `Thread` inside the Model, and the `Thread` fold runs inside
  `update` for every envelope. The Model's schema is `ChatUi.Thread` from the
  shared contract ([`src/chat-ui.ts`](src/chat-ui.ts)), so tool results are
  typed and decoded: Effect from the server's Schemas to the view.
- The open request is a Subscription keyed on the input in flight. Setting it
  sends the message; clearing it (Stop) tears the stream down, which aborts the
  request, and the server stops the model.
- The input id is random, so a Command creates it; `update` stays pure.

[`server.ts`](server.ts) is the backend: one Effect `HttpServer` route,
`POST /api/chat`, that answers each message with the run as Server-Sent
Events and keeps the history. The chat id is the envelopes' `streamId`, so the
page learns it from the first answer and sends it back.

## Tools and approvals

The same four tools as the TanStack Start and Next.js examples, from one shared
contract: `get_weather` (a REST call to Open-Meteo), `get_date`, and two stubs
that need your yes, `send_email` and `book_table`. A call that needs approval
ends the run as interrupted; its card shows Approve / Deny, which are plain
messages (`ClickedVerdict`) whose Command sends `Input.resolve`. In
[`server.ts`](server.ts), `needsApproval` picks the tools and `onFollowUp`
decides what a new message does to a waiting call: `book_table` is skipped,
`send_email` stays open.

Try: "Email bob@example.com that I'm late", then "What will the email say?",
then Approve.

## Run it

Build the linked packages once from the repo root (`pnpm build`), then:

```sh
cd examples/foldkit-chat
pnpm install
OPENAI_API_KEY=sk-... pnpm dev
```

`pnpm dev` starts the server on :4321 and Vite on :4320, which proxies `/api`
to the server. Open http://localhost:4320.

The packages come from the monorepo via `link:`, and `effect` is linked to the
monorepo's copy so everything shares one instance. A copy using published
`@effect-uai/*` packages drops both.
