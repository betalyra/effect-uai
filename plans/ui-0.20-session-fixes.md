# UI 0.20: session and transport fixes

Status: **agreed, ready to implement**. Date: 2026-11-10. Branch: `fix/ui-session-gaps`.

`@effect-uai/ui` 0.19 and the `durable-chat` recipe were only tested in examples and recipes. Building a full app on them (durable sessions, a chat hydrated from a database, deployed behind a proxy) exposed the gaps below.

Each gap was checked against the library's bar: an elementary, generic building block, built from existing Effect pieces. Anything that is app policy stays out (see "Rejected").

Release: `@effect-uai/ui` **0.20** (minor; item 2 is breaking), `@effect-uai/responses` patch. The examples are private packages and ship on this branch without a release.

## 1. `ReasoningEffort` type (`@effect-uai/responses`), done

`reasoning.effort` is typed `low | medium | high`, but current models also accept `none`, `minimal` and `xhigh`.

```ts
export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
readonly reasoning?: { readonly effort: ReasoningEffort }
```

Type only; nothing changes at runtime. `include: ["reasoning.encrypted_content"]` for `store: false` is **not** added automatically, because guessing would break non-reasoning models. Document it as an `extraBody` setting in `docs/providers/responses.md`.

## 2. `Transport.reconnect` replaces `HttpOptions.reconnect` (breaking)

**Problem.**

- Reconnecting is an option of `sessionHttp` / `durableHttp` only. Plain `Transport.session` / `Transport.durable` (any `Stream` source: WebSocket, RPC, server functions) have none, so those apps call `Client.resumable` by hand.
- The recipe uses `Schedule.spaced("1 second")`, which retries _every_ error forever. A deleted chat (404, which the recipe's own server returns) or an expired login (401) reconnects in a loop.
- A session stream that ends cleanly just completes: `open` succeeds, `ended` never runs, and the chat silently stops following.

**Design.** A pipeable combinator over a transport's event stream, modelled on `HttpClient.retryTransient`.

- A plain `Stream.retry` doesn't work: it re-runs `events(streamId, after)` with the original `after` and replays everything. `reconnect` re-opens from the last seq through the existing `Client.resumable`.

```ts
// before
Transport.sessionHttp({ send, events, stop, reconnect: Schedule.spaced("1 second") })

// after
Transport.sessionHttp({ send, events, stop }).pipe(
  Transport.reconnect({ schedule: Schedule.spaced("1 second") }),
)
Transport.session({ send, events: wsEvents, stop }).pipe(
  Transport.reconnect({ schedule: Schedule.exponential("500 millis"), while: isSocketDropped }),
)
```

```ts
export type ReconnectOptions<E> = {
  readonly schedule?: Schedule.Schedule<unknown, unknown> // default: capped, jittered exponential (below)
  readonly while?: Predicate.Predicate<E> // extra errors to treat as transient
  readonly times?: number // max attempts in a row; default unlimited
}

const defaultSchedule = Schedule.min([
  Schedule.exponential("500 millis"),
  Schedule.spaced("10 seconds"),
]).pipe(Schedule.jittered)
```

- Same options as `retryTransient` / `Effect.retry` (`until` left out; it is `while` negated).
- **Default backoff:** exponential so a long outage isn't hammered, jittered so every chat doesn't reconnect at once after a deploy, capped at 10 seconds.
- **The cap matters for sessions:** `Stream.retry` resets its schedule only when a frame passes, and heartbeat comments aren't frames. An idle chat behind a proxy that drops idle connections never resets, so an uncapped `Schedule.exponential` grows without bound. The `schedule` docs say so.

**An early end is an error (`Transport.session` / `Transport.durable`).**

- A session stream never ends by contract, so `Transport.session`'s `events` fails with `Client.Disconnected { lastSeq }` when it completes.
- A durable run stream that completes before its terminal fails the same way.
- The error type becomes `E | Client.Disconnected`. Without `reconnect`, the `open` / `resume` atom shows `Failure(Disconnected)` and `ended(…, "disconnected")` runs; with it, `Disconnected` is retried.

**`Durable` keeps `submit`.**

- Today `durable()` folds `submit` into `start`, so a combinator can't rebuild "submit once, then follow". `Durable` gains `submit`, and `start` is derived: `submit`, then `resume(streamId, 0)`.
- `reconnect` wraps `resume` and re-derives `start`. `submit` is never retried, so an input is never sent twice, and a drop before the first frame still resumes (the stream id is known).

**Default classification.**

- Transient: `Client.Disconnected`, `HttpClient.isTransientError` (timeouts, transport errors, 408 / 429 / 5xx), and `Sse.Retry` (a server's `retry:` line asking the client to reconnect).
- Anything else (404, 401, 403, malformed frames) ends the stream with that error.
- `while` adds the app's own errors, as in `retryTransient({ while })`. It is typed by the transport's `E`, so the app narrows without casts.
- Non-HTTP sources (WebSocket, RPC): only `Disconnected` (a clean close) is transient by default; pass `while` for the socket's error type. One docs line.

**Server-requested delay.** The schedule waits at least what the server asks for: `Retry-After` on an HTTP error (seconds or HTTP date) and `Sse.Retry.duration`. Built with `Schedule.modifyDelay` (Effect's own `withRetryAfter` is not exported).

**Scope and shape.**

- Applies to `Session` (follows forever) and `Durable` (stops after the run's terminal), told apart by `send` vs `submit`. The overloads return the same transport kind with `E | Client.Disconnected`.
- **Not for `direct` / `local`:** there the run _is_ the request, so there's no position to re-open from. The types reject it.
- **`sessionHttp` / `durableHttp` lose `reconnect`** and become plain HTTP mappings: `events: (id, after) => Client.sse(options.events(id, after))`.
- **What a stream that ends for good means** (e.g. 404 / 410 → reload state) stays app code. The error is in the `open` / `resume` atom's result.
- **Effect floor:** `HttpClient.isTransientError` is `@since 4.1.0`. Raise the `peer` catalog to `effect >=4.1.0 <5.0.0`.

## 3. `open` from a position, `sessionThread({ initial })` (additive)

**Problem.**

- `Atoms.session*`'s `open(id)` always calls `events(id, 0)`. A chat hydrated from a database replays from the start (redundant frames; servers with a replay floor reject it).
- The per-run atoms already have `resume({ streamId, after })`, so this is an asymmetry.
- `sessionThread` takes no `initial`, while `Atoms.thread` and `Atoms.session` do.

**Change.**

```ts
open: StreamId | { readonly streamId: StreamId; readonly after: number }   // bare id = after 0
Atoms.sessionThread({ contract, runtime, transport, initial?: Thread.Thread<P> })
```

```ts
// before: always a full replay, and the first render is empty
const chat = Atoms.sessionThread({ contract, runtime, transport })
registry.set(chat.state, hydrated)
registry.set(chat.open, chatId)

// after
const chat = Atoms.sessionThread({ contract, runtime, transport, initial: hydrated })
registry.set(chat.open, { streamId: hydrated.streamId, after: hydrated.lastSeq })
```

- **`initial` sets the state only, never the `streamId` atom**, as in `Atoms.thread`. `open` stays the one way to follow a chat. Seeding `streamId` would let `submit` send to the chat without following it (`submit` only opens a chat it created), so the answer would never appear.
- **Not in the library:** resetting or switching chats on one instance. `state` and `streamId` are writable atoms, so the app sets the state it wants, then calls `open({ streamId, after })`. The `Thread` fold keeps messages across stream changes on purpose (per-run durable transports use one stream per run).

## 4. `SseEncoding.heartbeat(interval)` (additive)

**Problem.** Session streams sit idle between answers, and proxies (cloud ingress, nginx) close idle connections. Effect's `Sse` encoder has no comment frames.

```ts
export const heartbeat =
  (interval: Duration.Input) =>
  <E, R>(self: Stream.Stream<Uint8Array, E, R>): Stream.Stream<Uint8Array, E, R> =>
    self.pipe(
      Stream.merge(Stream.tick(interval).pipe(Stream.map(() => comment)), { haltStrategy: "left" }),
    )
// usage
events.pipe(SseEncoding.encode, SseEncoding.heartbeat("15 seconds"))
```

- `comment` is `": heartbeat\n\n"` as bytes. `encode` emits one chunk per frame, so a comment always lands between whole frames.
- `Stream.tick` emits once immediately, so a response opens with a comment. Harmless.
- `haltStrategy: "left"`: it ends when the event stream ends.
- Browsers' `EventSource` and Effect's `Sse` parser ignore comment lines; the parser was checked.
- Named `heartbeat`, not `keepAlive`, to stay clear of `Atom.keepAlive` (Effect's) used next to it.

## 5. Recipe, docs, tests, changeset

- **Call sites of `reconnect`:** `recipes/durable-chat/client/main.ts` (`sessionHttp(...).pipe(Transport.reconnect())`), `recipes/durable-chat/README.md`, `docs/agentic-ui/index.md`. **`recipes/durable-chat/app.ts`:** `SseEncoding.heartbeat`. The examples don't use `durableHttp` / `sessionHttp`.
- **Docs:**
  - `docs/agentic-ui/index.md`, durable section: `Transport.reconnect`, its default classification and default backoff (cap it if you pass your own exponential); non-HTTP sources pass `while`; hydrate with `initial` + `open({ streamId, after })`; `heartbeat`; what to do when a stream ends for good;
  - `docs/providers/responses.md`: effort values, and `include` for stateless reasoning;
  - a migration note for 0.20: `reconnect` moved; without it, a dropped stream now fails with `Disconnected` instead of completing; `Durable` has `submit`.
- **Tests:**
  - `reconnect` re-opens from the last seq after a drop; doesn't retry a 404 / 401 (ends with that error); retries a 503 and an `Sse.Retry`; waits at least `Retry-After`; `while` extends the default; `times` caps attempts; `durable.start` never re-submits, including on a drop before the first frame;
  - `Transport.session` events that complete fail with `Disconnected`; a durable run that completes before its terminal does too;
  - `open({ after })` reads from `after`; `sessionThread({ initial })` starts with that state and a `null` `streamId`;
  - `heartbeat` interleaves comments, ends with the source, and `SseEncoding.decode` ignores them.
- **Changesets:** `@effect-uai/ui` minor (0.20, with the breaking `reconnect` move, the `Disconnected` early end and `Durable.submit` called out); `@effect-uai/responses` patch.

## 6. Examples: a streaming tool in all three chats (no release)

The FoldKit example gained `find_restaurants`, a tool that returns a `Stream` (stub data), so its results arrive typed, one by one. All three examples claim "the same four tools", so it goes into the others too.

- **TanStack Start:** `FindRestaurants` in `src/chat-ui.ts`, the tool in `src/server/chat.ts`, a renderer for the growing list.
- **Next.js:** the same in the effect-uai chat (`lib/chat-ui.ts`, `lib/tools.ts`, its page). The AI SDK chat (`app/api/chat/route.ts`) drops partials, so the list arrives at the end there; add a one-line comment saying so. Streaming partials through the AI SDK adapter is separate work.
- **FoldKit:** server on :4325 (Astro's dev server takes 4321), already done.
- **Docs:** "four tools" → five in the three READMEs; one line on the streaming tool in `docs/agentic-ui/{foldkit,tanstack-start,nextjs}.md`.
- Revert `examples/tanstack-start-chat/src/routeTree.gen.ts` (the generator only switched quote style).

## Rejected (app policy, or already expressible with Effect)

- **A `retryable` option on `Client.resumable`:** the schedule already receives each error as input. `Schedule.while` + `HttpClient.isTransientError` express it, and `Transport.reconnect` packages that default.
- **A typed `Client.Gone` error for 404 / 410:** "410 means rehydrate" is one server's convention. The app reads the status from the error.
- **`position` / `reset` options, and auto-reset in `open` when switching chats:** policy; the app writes the state atom.
- **Seeding `streamId` from `initial`, or `submit` auto-opening a chat it didn't create:** hidden behaviour; `open` is explicit, as `resume` is for per-run atoms.
- **A new `input-consumed` protocol event** for messages taken in between agent turns: the existing `run-completed` + `run-started { inputs }` express it (end the run at the turn boundary, continue the loop in a new run). Taking in messages between turns is the app's server code, as in the durable-chat recipe.
- **A server-side `Session` module** (the server half of `Transport.session`): storage and restore, fan-out across instances, scheduling (one run at a time, bursts, queue vs refuse), eviction, timeouts and replay floors are all app policy. A module owning them would own the app's control flow. The durable-chat recipe composes `Run.*` + `PubSub` instead. The one generic piece (atomic seq + replay from `after`) is ~15 lines; reconsider only if a second server repeats it.

## Later (not in this release)

**Streaming tool partials through the AI SDK adapter** (`preliminary` tool output), so the Next.js AI SDK chat shows them live.
