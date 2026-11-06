# effect-uai + TanStack Start

A chat app on [TanStack Start](https://tanstack.com/start) over
`@effect-uai/ui`: a server route runs the agent, React reads the state from
atoms. Tool results arrive typed through a shared contract
([`src/chat-ui.ts`](src/chat-ui.ts)).

- [`src/server/chat.ts`](src/server/chat.ts): the server. Each message is one
  request; the response streams the run as Server-Sent Events, and the server
  keeps the history. The chat id is the envelopes' `streamId`, so the page
  learns it from the first answer and sends it back with the next. It is a
  plain Effect `HttpRouter` route, turned into a web handler by
  `HttpRouter.toWebHandler`.
- [`src/routes/api/chat.ts`](src/routes/api/chat.ts): the server route,
  `POST /api/chat`, handing the `Request` to that handler.
- [`src/chat.ts`](src/chat.ts): the page's state, `Atoms.thread` over
  `Transport.direct`.
- [`src/routes/index.tsx`](src/routes/index.tsx): the page, reading the atoms
  with `@effect/atom-react` (`useAtomValue`, `useAtomSet`).

Stop aborts the request; the server sees the request go away and stops the
model. A reload starts a new chat.

## Run it

Build the linked packages once from the repo root (`pnpm build`), then:

```sh
cd examples/tanstack-start-chat
pnpm install
OPENAI_API_KEY=sk-... pnpm dev
```

Open http://localhost:5173.

The packages come from the monorepo via `link:`, and `effect` is linked to the
monorepo's copy so everything shares one instance. A copy using published
`@effect-uai/*` packages drops both.
