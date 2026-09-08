# Plan: Messenger capability (Telegram / Discord / Slack agents)

Research reports (raw, per platform) live in
[research/messenger/](research/messenger/): [telegram.md](research/messenger/telegram.md),
[discord.md](research/messenger/discord.md), [slack.md](research/messenger/slack.md),
[whatsapp.md](research/messenger/whatsapp.md). This plan is the summary and the
decisions. Research date: 2026-09-06.

## Why

effect-uai already ships the primitives an _interactive_ agent needs:
`InteractionTool` ("a typed request for an external actor to respond before the
loop resumes"), `Approval` (human verdicts on gated tool calls), the
agentic-loop recipe (pull user messages from a queue, debounce bursts, check
for input only at clean turn boundaries), pause/resume, and mid-stream abort.
What it does not ship is any way to _reach_ an external actor.

Messaging is the missing inbound capability. Every existing capability is
outbound (the agent acts on the world: search, read, browse, execute); this is
the one where the world talks to the agent. The flagship it unlocks: a
streaming, tool-using agent that lives in a Telegram chat, a Discord channel or
a Slack thread in a few dozen lines of Effect, with the loop, tools, and history
it already has.

The tag is called `Messenger` (not `Chat`, which collides with
`effect/unstable/ai/Chat`, the LLM-conversation abstraction, and reads as the
agent rather than its channel).

Unification is honest here, unlike agent-memory services (which do not reduce
to a shared interface and were rejected on those grounds). What varies between
Telegram, Discord and Slack is plumbing, not product: a handful of outbound
verbs and one tagged inbound stream cover the shared 80%, and a `raw` escape
hatch carries the rest without lying about it. The research confirmed this
with one correction: _progressive delivery_ is now a first-class verb, because
two of the three platforms grew native streaming APIs and the third needs
edit-in-place, so "stream" is a shared intent with a per-adapter mechanism.

## What the research settled

### No SDK dependencies, anywhere

| Platform | Inbound transport                               | Public endpoint? | Official TS SDK         | Effect deps needed                    |
| -------- | ----------------------------------------------- | ---------------- | ----------------------- | ------------------------------------- |
| Telegram | HTTPS long-poll `getUpdates` (timeout 30-50s)   | no               | none (grammY, telegraf) | `HttpClient`                          |
| Discord  | Gateway websocket (identify, heartbeat, resume) | no               | none (types only)       | `HttpClient` + `Socket`               |
| Slack    | Socket Mode websocket (`apps.connections.open`) | no               | optional (`@slack/*`)   | `HttpClient` + `Socket`               |
| WhatsApp | Webhook only (Cloud API)                        | **yes**          | archived 2023           | `HttpServer` + `HttpClient` (phase 2) |

All three v1 platforms are plain JSON over HTTPS plus (for two of them) one
websocket. Endpoint counts for a full agent bot: Telegram ~10, Discord ~6 REST
routes plus the gateway state machine (~250 lines), Slack ~10 methods plus the
Socket Mode envelope loop (~100 lines). Nothing here justifies a dependency;
the realtime adapters (`Socket.makeWebSocket`, `closeCodeIsError`, reader fiber
into `Queue<_, Cause.Done>` ended with `Queue.end`) are the template.

### Progressive delivery differs per platform, so it is a verb

| Platform | Native streaming                                                                    | Fallback                                   | Text limit |
| -------- | ----------------------------------------------------------------------------------- | ------------------------------------------ | ---------- |
| Telegram | `sendMessageDraft` (private chats only, ephemeral draft, finish with `sendMessage`) | `sendMessage` + `editMessageText` at ~1s   | 4096       |
| Discord  | none                                                                                | `POST` + `PATCH` at ~1.2s, 5 edits/5s/chan | 2000       |
| Slack    | `chat.startStream` / `appendStream` (Tier 4) / `stopStream`, standard markdown      | `chat.postMessage` + `chat.update`         | ~4000      |
| WhatsApp | none, and **no edit at all**                                                        | send whole chunks                          | 4096       |

The first draft of this plan derived streaming from `post` + `edit` in core.
That would leave Slack's native stream (with its stop button and feedback
blocks) and Telegram's draft animation unreachable, and it would be wrong for
WhatsApp. So `stream` is an adapter verb; core ships the post-then-edit
strategy as a helper the adapters without native streaming reuse.

### Things that are not uniform and stay out of core

- **Ephemeral messages.** Slack: `chat.postEphemeral`. Telegram: only since Bot
  API 10.2 and only in groups. Discord: only as an interaction response (flag
  64), unreachable from a plain message flow. WhatsApp: 1:1 so meaningless.
  Dropped from v1 core (it was in the first draft); reachable via `raw`.
- **Buttons / cards.** Discord components (v2), Slack Block Kit, Telegram inline
  keyboards, WhatsApp reply buttons (max 3). Not unified; `raw` only in v1.
- **Reactions** are uniform in intent, not in vocabulary: Telegram allows a
  fixed set of 73 emoji, Slack takes shortcode names (`eyes`), Discord takes
  URL-encoded unicode. `react` takes unicode; adapters map (Slack) or fail
  typed with `MessengerUnsupported` (Telegram, off-set emoji).
- **Formatting.** Model output is markdown. Slack accepts standard markdown
  (`markdown_text`, both in `postMessage` and the stream methods), Discord's
  markdown is near-standard, Telegram wants HTML or MarkdownV2 (escaping every
  punctuation char), WhatsApp has a four-style subset. Core text is markdown;
  every adapter owns a markdown-to-platform converter. The Telegram one
  (markdown to HTML: bold, italic, code, pre, links, escaping) is the only
  non-trivial one and is a named work item.

### Platform-specific constraints the adapters absorb

- **Telegram privacy mode.** With the default BotFather setting a bare
  `@bot` mention in a group is _not delivered_; only commands, replies to the
  bot and DMs are. Docs must say: disable privacy mode (`/setprivacy`) or make
  the bot an admin for mention-to-address UX. Also: one poller per token
  (`409 Conflict` otherwise), `message_reaction` updates need
  `allowed_updates` and admin rights.
- **Discord intents.** A mention-or-DM bot needs no privileged intent:
  `content` is populated for DMs and messages that mention the bot even
  without `MESSAGE_CONTENT`. Intents mask for the v1 use case: 46593.
- **Slack acks.** Every Socket Mode envelope must be acked within 3s or Slack
  retries (three times, with `retry_attempt` set). The adapter acks on receipt
  before enqueueing, and dedupes on `event_id`. `app_mention` and
  `message.channels` both fire for the same message; dedupe on `(channel, ts)`.
- **Reconnection is the adapter's job.** Slack rotates connections roughly
  hourly (`disconnect` frames), Discord requires resume-on-close for a fixed
  set of codes, Telegram just retries the poll. The `events` stream does not
  fail on a routine reconnect; `MessengerTransportClosed` surfaces only when
  the reconnect budget is exhausted or the close is fatal (Discord 4004/4013/
  4014, Slack `link_disabled`, Telegram 401).
- **Typing.** Telegram's indicator lasts 5s, Discord's 10s, WhatsApp's 25s
  (and needs the inbound message id), Slack has no typing in channels but has
  `agents.sessions.setStatus(processing)`. So `typing` is _scoped_: the adapter
  keeps the indicator alive while the scope is open and clears it on close.
- **Action events must be answered.** Telegram `callback_query` needs
  `answerCallbackQuery`, Slack `block_actions` needs the envelope ack, Discord
  component interactions need a callback within 3s. Adapters auto-answer at
  the transport level so recipes never see the deadline.

### WhatsApp: phase 2, and a different product

Webhook-only, so it needs a public HTTPS endpoint (tunnel for local dev),
HMAC verification, and immediate 200 with async processing. No message edits
means no streaming. 24-hour customer-service window; bot-initiated messages
outside it require approved templates. Groups only for Official Business
Accounts. It still fits the `Messenger` tag (`post`, `react`, `typing`,
`stream` as chunked sends) but its transport is inverted, which is the webhook
mode work below. Nothing in v1 forecloses it.

## Scope

**v1 (this plan):**

- Core `Messenger` capability tag: one inbound `Stream<InboundEvent>`, five
  outbound verbs (`post`, `edit`, `react`, `typing`, `stream`), branded ids,
  markdown text, `raw` escape hatch.
- Ambient conversation targeting: `CurrentConversation` in `R`, established
  with `inConversation(ref)`.
- Core `streamViaEdits` helper (coalesced post-then-edit with chunking at the
  platform text limit), reused by adapters without native streaming.
- Official adapter set stays **Telegram, Discord, Slack, WhatsApp** and stops
  there. v1 ships the three persistent-connection ones in this order:
  `@effect-uai/telegram` (long-poll), `@effect-uai/discord` (gateway),
  `@effect-uai/slack` (Socket Mode). WhatsApp is phase 2.
- A messaging-agent recipe (addressed message -> streamed answer, tools,
  per-conversation history). Orchestration is the recipe's, never the
  library's.

**Deferred (say so in docs, do not build yet):**

- **Webhook mode, the defined phase 2.** WhatsApp is webhook-only, Telegram
  optionally supports webhooks, Discord optionally supports an interactions
  endpoint. Webhooks invert the model: one HTTP request, answer within a
  deadline. That duality is the hard design problem of the domain; v1 stays
  long-lived-process only. Keeping connection lifecycle inside the Layer (no
  connect/disconnect methods on the service) is what keeps the door open.
- Ephemeral messages, cards, buttons, and approval-over-buttons (a recipe over
  `Approval.fromQueue` fed by `Action` events, plus per-platform button
  rendering).
- Files and media (`sendDocument`, Discord multipart, Slack two-step upload).
  Uniform in intent, three different upload dances; wait for a recipe that
  needs it.
- An `ask` helper (post a question, resume the loop on the user's reply).
- Voice channels (Realtime territory), non-target platforms (Teams, Google
  Chat, GitHub, Linear).

## Package layout

```
packages/core/src/messenger/
  Messenger.ts          # tag, ids, InboundEvent, Outbound, CurrentConversation, inConversation, streamViaEdits
  MessengerError.ts     # tagged errors + describe
packages/core/src/testing/
  MockMessenger.ts      # scripted inbound, recorded outbound
packages/providers/telegram/     # v1 first: long-poll getUpdates
  src/Telegram.ts       # provider tag + layer({ token }): Layer<Telegram | Messenger, never, HttpClient>
  src/internal/api.ts   # envelope decoder, ~10 methods, retry_after
  src/internal/markdown.ts   # markdown -> Telegram HTML
  src/internal/events.ts     # Update -> InboundEvent, addressed-to-bot rule
packages/providers/discord/      # v1 second: gateway websocket
  src/Discord.ts        # layer({ token, intents? })
  src/internal/gateway.ts    # hello/identify/heartbeat/resume state machine
  src/internal/rest.ts       # bucketed REST client
packages/providers/slack/        # v1 third: Socket Mode
  src/Slack.ts          # layer({ botToken, appToken })
  src/internal/socketMode.ts # envelope loop, 3s ack, rolling reconnect
  src/internal/api.ts        # Web API methods incl. chat.*Stream
packages/providers/whatsapp/     # phase 2: Cloud API, webhook mode
recipes/messenger-agent/         # README.md, recipe.ts, app.ts, run.ts, recipe.test.ts
docs/messenger/                  # index.md + providers/{telegram,discord,slack}.md
```

Core carries zero platform logic; adapters carry zero AI logic. The
`Messenger` tag is the seam. Provider packages follow the `exa` layout
(`tsdown`, subpath exports, core as dev+peer dependency) and debut at the
current fixed-group version.

## Key design decisions

### 1. The service: five verbs + one event stream

```ts
export type ChannelId = Brand.Branded<string, "ChannelId">
export type MessageId = Brand.Branded<string, "MessageId">
export type UserId = Brand.Branded<string, "UserId">

// `thread` is opaque and provider-interpreted: Slack thread_ts, Telegram
// forum message_thread_id, unused on Discord (a thread is its own channel).
export type ConversationRef = { readonly channel: ChannelId; readonly thread?: string }
export type MessageRef = { readonly conversation: ConversationRef; readonly id: MessageId }

export type InboundEvent = Data.TaggedEnum<{
  Message: {
    conversation: ConversationRef
    id: MessageId
    author: UserId
    text: string // mention of the bot stripped
    addressed: boolean // DM, or mentions the bot, or replies to the bot
    replyTo?: MessageId
    raw: unknown
  }
  Reaction: {
    conversation: ConversationRef
    message: MessageId
    emoji: string
    author: UserId
    raw: unknown
  }
  Command: {
    conversation: ConversationRef
    name: string
    args: string
    author: UserId
    raw: unknown
  }
  Action: {
    conversation: ConversationRef
    actionId: string
    value?: string
    author: UserId
    raw: unknown
  }
}>

// Text is markdown; adapters convert. `raw` is passed to the platform as-is.
export type Outbound =
  string | { readonly text: string; readonly replyTo?: MessageId } | { readonly raw: unknown }

export type MessengerService = {
  readonly events: Stream.Stream<InboundEvent, MessengerError>
  readonly post: (msg: Outbound) => Effect.Effect<MessageId, MessengerError, CurrentConversation>
  readonly edit: (msg: MessageRef, next: Outbound) => Effect.Effect<void, MessengerError>
  readonly react: (msg: MessageRef, emoji: string) => Effect.Effect<void, MessengerError>
  // Activity indicator, kept alive until the scope closes.
  readonly typing: Effect.Effect<void, MessengerError, CurrentConversation | Scope.Scope>
  // Progressive delivery of a text stream; mechanism is the adapter's.
  readonly stream: <E, R>(
    text: Stream.Stream<string, E, R>,
  ) => Effect.Effect<MessageId, MessengerError | E, R | CurrentConversation>
  readonly limits: { readonly maxText: number }
}

export class Messenger extends Context.Service<Messenger, MessengerService>()(
  "@betalyra/effect-uai/Messenger",
) {}
```

Changes from the first draft, all forced by the research: `stream` replaces
`ephemeral` (streaming is uniform in intent and non-uniform in mechanism;
ephemeral is neither), `typing` is scoped (three different expiry windows),
`mention` became `addressed` (the DM / mention / reply-to-bot rule is what
recipes actually branch on, and it is where Telegram privacy mode and Discord
intents are absorbed), `Command.args` is a string (Telegram and Slack deliver
raw text, only Discord has typed options), `raw` is on every event, and
`limits.maxText` is exposed so recipes can see the platform ceiling. `post`
splits over-long text at the limit on paragraph boundaries and returns the
last id; `stream` rolls over to a new message when the buffer exceeds it.

`edit` and `react` take an explicit `MessageRef` (you can only edit a message
you can name); the conversation-targeting verbs are ambient (next decision).

### 2. Ambient conversation targeting (`CurrentConversation` in `R`)

```ts
export class CurrentConversation extends Context.Tag(
  "@betalyra/effect-uai/Messenger/CurrentConversation",
)<CurrentConversation, ConversationRef>() {}

export const inConversation =
  (ref: ConversationRef) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, CurrentConversation>> =>
    Effect.provideService(effect, CurrentConversation, ref)
```

The reader pattern, with `RpcClient.CurrentHeaders` / `withHeaders` as
precedent. The conversation target must reach _deep_ code: a tool's `run`
posting progress, an approval resolver posting buttons, an interaction prompt.
Ambient context means the recipe wraps each conversation fiber once and every
nested post lands correctly with no ref threading. A `Tag` (no default) rather
than a `Reference`: posting outside an established conversation is a compile
error.

Multi-conversation work (escalation to an ops channel) is re-scoping:

```ts
yield * messenger.post("On it, escalating.") // ambient: the user's thread
yield * inConversation(onCall)(messenger.post(summary)) // re-scoped: the ops channel
```

### 3. `streamViaEdits`: the shared fallback strategy (core)

```ts
// The post-then-edit strategy for adapters without native streaming.
// Coalesces deltas by time and growth, skips no-op edits, honours
// MessengerRateLimited.retryAfter, rolls over past maxText, flushes a final edit.
export const streamViaEdits: (
  verbs: { post; edit; limits },
  options?: { every?: Duration.Input; minChars?: number },
) => <E, R>(
  text: Stream.Stream<string, E, R>,
) => Effect.Effect<MessageId, MessengerError | E, R | CurrentConversation>
```

Debounce/coalesce of a delta stream is exactly the library's Stream
wheelhouse, and it is needed by at least two adapters (Discord always,
Telegram in groups), so it lives in core. Defaults: 1 second and 40 chars
(Discord's observed 5-edits-per-5s bucket and Telegram's undocumented edit
limit both sit around 1/s). Adapters with native streaming (Slack everywhere,
later Telegram in private chats via `sendMessageDraft`) implement `stream`
directly and may fall back to this helper on a streaming error.

The recipe feeds `stream` with `Turn.textDeltas(streamTurn(...))`, which
already exists in core. Tool-call status lines ("searching...") are one
`post` per `ToolCallStart` in the recipe; a `Turn.toMessages` projection with
`Status`/`Settle` actions (in the first draft) is deferred until the recipe
shows it is needed. Note: `Turn.toSSE` / `toJSONL` are recipe code, not core,
so there is no core sibling to mirror.

### 4. Approval is `Approval.fromQueue`, not a new primitive

There is no `Approval.fromMessenger`. Approve/deny-over-buttons is
`Approval.fromQueue` with two thin recipe pieces around it (post the buttons
via `raw` when a gate opens; on an `Action` event decode `approve:<id>` /
`deny:<id>` and offer the verdict). Adding a named wrapper would be a
provider-specific shortcut over a generic helper. Kept out of v1 because the
button-rendering half is per-platform and the basic recipe needs no `Action`
demux: text in, streamed text out.

### 5. Providers: a `Layer` owning a scoped connection

`Telegram.layer({ token })` returns `Layer<Telegram | Messenger, never, HttpClient>`
(provider tag plus capability tag over one implementation, the `exa` shape).
Building the layer starts the poll loop (or the websocket) in a forked scoped
fiber feeding a `Queue<InboundEvent, Cause.Done>`; scope close ends the queue
with `Queue.end` and tears the connection down. `events` is
`Stream.fromQueue` and is single-consumer (document it). Tokens are
`Redacted` end to end. Reconnection, acks, dedupe and callback answering all
happen inside the adapter (see "constraints the adapters absorb").

Telegram ships first: no websocket, no ack deadline, no intents, one HTTP
client, and a BotFather token takes a minute to get. Discord second (gateway
state machine, the most transport work, the fastest to test end to end).
Slack third, and it is the adapter that proves the `stream` verb carries a
native streaming API (`chat.startStream` with its stop button) and not only
edit-in-place.

### 6. Orchestration is a recipe

The library never owns the router. The recipe is explicit queues and forked
fibers, in the house style:

- A `Ref<HashMap<string, Queue<InboundEvent, Cause.Done>>>` of inboxes keyed
  by conversation.
- On first addressed message in a conversation: create the inbox, fork one
  agentic-loop fiber wrapped in `inConversation(ref)` (`Effect.forkScoped`).
- A dispatch loop: `Stream.runForEach(messenger.events, route)`.
- Inside each fiber: the agentic-loop recipe unchanged (`drainBurst`, one
  batch per clean turn, history as loop state), `typing` held for the turn,
  `stream(Turn.textDeltas(...))` as the sink, mid-stream abort wired to a new
  message arriving.

### 7. Errors (`MessengerError.ts`)

`Data.TaggedError` family with a `describe`, mirroring `BrowserError`:

- `MessengerConnectFailed` (auth or handshake failure on layer build; Discord
  4004/4013/4014, Slack invalid `xapp` token, Telegram 401).
- `MessengerTransportClosed` (reconnect budget exhausted or fatal close; the
  `events` stream fails with it).
- `MessengerRequestFailed` (an outbound verb rejected: permissions, unknown
  chat, message too long; carries provider `reason` + `raw`).
- `MessengerRateLimited` (carries `retryAfter: Duration` from Telegram
  `retry_after`, Discord `retry_after`, Slack `Retry-After`; adapters surface
  it typed so recipes and `streamViaEdits` retry deliberately).
- `MessengerUnsupported` (the wired platform cannot do it: off-set reaction
  emoji on Telegram, `edit` on WhatsApp).

## Sequencing

1. **Core `Messenger.ts` + `MessengerError.ts`** (tag, ids, events enum,
   verbs, ambient targeting, `streamViaEdits`) + `MockMessenger` test layer.
   `streamViaEdits` is tested on the mock: coalescing, no-op skip, rollover,
   rate-limit retry, final flush.
2. **`@effect-uai/telegram`**: `getMe`, long-poll loop with offset ack and
   `allowed_updates`, `Update` -> `InboundEvent` with the addressed rule,
   markdown-to-HTML, `sendMessage`/`editMessageText`/`setMessageReaction`/
   `sendChatAction` keepalive, `stream` = `streamViaEdits` (drafts are a
   follow-up, see handoff notes), `answerCallbackQuery` auto-ack. End to end:
   DM the bot, get a streamed tool-using answer.
3. **The `messenger-agent` recipe** (router + per-conversation agentic loop),
   runnable against mock and Telegram, plus `docs/messenger/index.md` and
   `providers/telegram.md` (with the privacy-mode note).
4. **`@effect-uai/discord`**: gateway state machine, REST verbs, mention
   events without privileged intents, `stream` via `streamViaEdits`. Every
   decision is pinned in "Discord handoff" below; the protocol facts are in
   [research/messenger/discord.md](research/messenger/discord.md).
5. **`@effect-uai/slack`**: Socket Mode loop with 3s acks and rolling
   reconnect, `chat.startStream`-backed `stream`, `agents.sessions.setStatus`
   as `typing`. Three transports on one tag is the proof the abstraction holds.
6. Changesets (fixed group), skill cheat-sheet row, docs sidebar.
7. **Phase 2**: webhook mode, then `@effect-uai/whatsapp`; the
   approval-over-buttons recipe once per-platform button rendering exists.

## Testing

- `MockMessenger`: a scripted `events` stream + a `Ref` log of outbound calls.
  All recipe tests run against it; no network.
- `streamViaEdits`: delta bursts coalesce per `every`/`minChars`; identical
  content does not edit; rollover past `maxText`; `MessengerRateLimited`
  is retried after `retryAfter`; the final delta always lands.
- Telegram `Update` decoding and the addressed rule (private chat, `@bot`
  entity, `/cmd@bot`, reply to bot) and markdown-to-HTML are pure and unit
  tested against fixture payloads.
- Ambient targeting: `expectTypeOf` that `messenger.post` without
  `inConversation` fails to compile.
- Adapter live tests in `integration-tests/<platform>/` behind env-gated
  tokens (`describe.skipIf`), the `sandbox-deno` pattern.

## Risks / open questions

- **Adapter maintenance is the real cost.** Platform APIs churn (Slack
  deprecates `assistant.threads.*` in Feb 2027, Discord raised the privileged
  intent bar in Jun 2026, Telegram ships a Bot API release every few weeks).
  Contained by the five-verb contract, the fixed four-platform set, `raw`
  instead of card dialects, and a documented adapter contract so community
  adapters do not become our surface.
- **Markdown conversion quality.** Model output into Telegram HTML is the one
  place a converter bug is user-visible on every message. Start with the
  subset the models actually emit (bold, italic, code, pre, links, lists as
  plain text) and fail soft to plain text on a 400 `can't parse entities`.
- **Webhook mode pressure.** Serverless users will ask immediately. Docs state
  the v1 boundary plainly (persistent process, one instance per token).
- **Coalescing tuning.** Edit rate limits are undocumented on Telegram and
  community-observed on Discord; ship conservative defaults, expose the knobs,
  and learn from headers on Discord rather than hard-coding buckets.
- **Thread semantics.** `ConversationRef.thread` carries Slack `thread_ts` and
  Telegram forum topics; Telegram reply chains have no thread id and Discord
  threads are channels. Verify the recipe's per-conversation keying stays
  sensible on all three before freezing the type.

## Appendix: what a basic integration looks like

The point is the _shape_: a web-search agent that answers when addressed.
Approvals and button flows are a separate recipe (decision 4).

### 1. The tool

```ts
const searchTool = Tool.make({
  name: "search",
  description: "Search the web.",
  inputSchema: Tool.fromEffectSchema(Schema.Struct({ query: Schema.String })),
  run: ({ query }) => WebSearch.search({ query }),
})

const toolkit = Toolkit.make(searchTool)
```

### 2. The per-conversation loop

One fiber per conversation, reading from its own inbox. Everything runs inside
`inConversation(ref)` so `post`, `typing` and `stream` land in this
conversation without threading a ref through `streamTurn` or the tool.

```ts
const conversation = (ref: ConversationRef, inbox: Queue.Queue<InboundEvent, Cause.Done>) =>
  Effect.gen(function* () {
    const messenger = yield* Messenger
    const lm = yield* LanguageModel

    yield* loop((state: State) =>
      Effect.gen(function* () {
        const incoming = needsUserInput(state) ? yield* drainBurst(inbox, "800 millis") : []
        const history = [...state.history, ...incoming.map((m) => Items.userText(m.text))]

        return lm.streamTurn({ history, model, tools: toolkit }).pipe(
          Stream.tap((e) =>
            e._tag === "ToolCallStart" ? messenger.post(`_${e.name}..._`) : Effect.void,
          ),
          Turn.textDeltas,
          messenger.stream, // native stream or post+edit, the adapter decides
          Effect.scoped, // releases `typing`
          Effect.map(/* next(state with turn appended) */),
        )
      }).pipe(Effect.provideServiceEffect(/* hold typing for the turn */)),
    )({ history: [] })
  }).pipe(inConversation(ref))
```

`streamTurn` is the ordinary loop primitive, unaware it is speaking to
Telegram. The only messenger-specific lines are the status post, `stream` and
`typing`.

### 3. The router and `main`

```ts
const router = Effect.gen(function* () {
  const messenger = yield* Messenger
  const inboxes = yield* Ref.make(HashMap.empty<string, Queue.Queue<InboundEvent, Cause.Done>>())

  const inboxFor = (ref: ConversationRef) =>
    Effect.gen(function* () {
      const key = `${ref.channel}/${ref.thread ?? ""}`
      const found = HashMap.get(yield* Ref.get(inboxes), key)
      if (Option.isSome(found)) return found.value
      const inbox = yield* Queue.make<InboundEvent, Cause.Done>()
      yield* Ref.update(inboxes, HashMap.set(key, inbox))
      yield* conversation(ref, inbox).pipe(Effect.forkScoped)
      return inbox
    })

  yield* Stream.runForEach(messenger.events, (event) =>
    event._tag === "Message" && event.addressed
      ? Effect.flatMap(inboxFor(event.conversation), (inbox) => Queue.offer(inbox, event))
      : Effect.void,
  )
})

router.pipe(
  Effect.scoped,
  Effect.provide(Telegram.layer({ token: Redacted.make(process.env.TELEGRAM_BOT_TOKEN!) })),
  Effect.provide(OpenAILayer),
  Effect.provide(Exa.layer({ apiKey })),
  Effect.provide(NodeHttpClient.layerUndici),
  Effect.runFork,
)
```

Swapping Telegram for Discord or Slack is one `Effect.provide` line. The
tool, the loop, the router and the streaming sink are untouched, which is the
whole claim of the capability made concrete.

### What the user sees

They message the bot (or mention it in a group with privacy mode off); it
shows typing, posts a short status line if it runs a search, then streams its
answer: as one edited message on Telegram and Discord, as a native streamed
message with a stop button on Slack (and, once drafts land, as an animated
draft in a Telegram DM).

## Implementation notes (handoff)

Decisions pinned after review, so an implementer does not have to re-derive
them:

1. **Effect v4 (effect-smol) APIs only.** `CurrentConversation` is declared
   like every other core tag:
   `class CurrentConversation extends Context.Service<CurrentConversation, ConversationRef>()("@betalyra/effect-uai/Messenger/CurrentConversation") {}`.
   There is no `Context.Tag` here.
2. **Telegram `stream` in v1 is `streamViaEdits` everywhere**, private chats
   included. `sendMessageDraft` (animated drafts in DMs) is a follow-up
   changeset once the basic flow is live.
3. **Inbound queue: unbounded, acknowledge first.** Adapters advance the
   Telegram offset (or ack the Slack envelope) before `Queue.offer`. The
   platform is never back-pressured by a slow recipe; a recipe that cannot
   keep up is a recipe bug, and Slack's 3s ack deadline makes backpressure
   wrong anyway.
4. **No-op edits are not swallowed.** Telegram rejects an edit with unchanged
   text (400 "message is not modified"); Discord and Slack accept it. The
   adapter surfaces it as `MessengerRequestFailed` with the Telegram reason.
   Uniformity comes from `streamViaEdits`, which never sends unchanged text,
   not from hiding a platform response. Note the difference in
   `docs/messenger/providers/telegram.md`.
5. **Telegram poller requests `allowed_updates`** =
   `["message", "edited_message", "callback_query", "message_reaction"]` on
   every `getUpdates` call. Without it Telegram never delivers reactions. The
   list is sticky on Telegram's side; reactions in groups additionally need
   the bot to be an admin (doc note).
6. **Telegram `Command` rule.** A `bot_command` entity at offset 0 becomes
   `Command { name, args }` with any `@botname` suffix stripped and `args` the
   remaining text after the command word. Everything else is a `Message`, even
   though Telegram tags a mid-text `/word` as a `bot_command` entity too.
   `/start` goes through the same rule; greeting on it is the recipe's job.

## Discord handoff

Steps 1 to 3 shipped on Telegram; this is step 4. Build it against the
capability exactly as it is: nothing on Discord needs a new field or verb
(see "What does not map" at the end). Mirror the Telegram package in shape
and style: `packages/providers/discord/src/Discord.ts` (config, `Discord`
tag, `make`, `layer`), `src/internal/rest.ts` (the `Api` twin: one `call`,
one `upload`, `decoded`), `src/internal/gateway.ts` (the websocket session),
`src/internal/events.ts` (pure dispatch-to-`InboundEvent` mapping, exported
schemas). Plain `HttpClient` and `Socket`, no discord.js, no
`discord-api-types`.

1. **Config.** `layer({ token, intents?, stream?, baseUrl? })`. `intents`
   defaults to `GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_REACTIONS |
DIRECT_MESSAGES | DIRECT_MESSAGE_REACTIONS` (`1 | 512 | 1024 | 4096 |
8192`); `MESSAGE_CONTENT` (`32768`) is opt-in, and the doc says a
   mention-or-DM bot does not need it. `stream` defaults `every` to
   `"1200 millis"`, under the observed 5-edits-per-5s bucket. REST base
   `https://discord.com/api/v10`, header `Authorization: Bot <token>` and
   `User-Agent: DiscordBot (https://effect-uai.betalyra.com, <version>)`.
   `DiscordService = MessengerService & { bot: { id, username } }`, registered
   under `Discord` and `Messenger` like Telegram.
2. **Layer build waits for `READY`.** `GET /users/@me` first (bad token is
   `MessengerConnectFailed` immediately), then open the gateway and return
   from `make` only once `READY` arrived. A fatal close before that (4004,
   4010 to 4014, notably 4014 for a privileged intent not toggled in the
   portal) is `MessengerConnectFailed` with the close reason, not a
   `TransportClosed` a second later. `events` starts after `READY`.
3. **Gateway session.** `GET /gateway/bot` for the URL. On Hello: identify
   (or resume), then heartbeat every `heartbeat_interval` with the first one
   jittered; track the last `s`; if no ACK arrives between two heartbeats,
   close with a non-1000 code and reconnect. Op 1 requests an immediate
   heartbeat. Store `session_id` and `resume_gateway_url` from `READY`. On
   close or op 7: resumable codes (4000 to 4003, 4005, 4008) and op 9 with
   `true` resume on `resume_gateway_url`; 4007, 4009 and op 9 with `false`
   wait 1 to 5 s and identify fresh; fatal codes end `events` with
   `MessengerTransportClosed`. Reconnects retry forever on an exponential
   schedule capped at 60 s. `Socket.makeWebSocket` with `closeCodeIsError:
(code) => code !== 1000 && code !== 1001 && code !== 1005`; the reader
   fiber ends the inbox with `Queue.end`. No compression, `encoding=json`.
4. **`addressed`.** DM (`guild_id` absent), or the bot's id in `mentions`,
   or `referenced_message.author.id` is the bot. `mention_everyone` and role
   mentions do not count. Strip `<@id>` and `<@!id>` for the bot from `text`
   and trim. Messages with `author.bot === true` are dropped entirely, never
   delivered, so two bots cannot loop. `replyTo` is
   `referenced_message.id` when present.
5. **Threads.** A thread is a channel: `ConversationRef.channel` is the
   thread's channel id and `thread` stays unset. Nothing else changes;
   `conversationKey` already keys per thread that way.
6. **No `Command` events in v1.** Discord has no text-command convention;
   slash commands need REST registration and an interaction response within
   3 s, both a follow-up. Document that `/start` does not exist here and the
   recipe starts a conversation on the first DM or mention.
7. **`Action` from components.** `INTERACTION_CREATE` with `type: 3` becomes
   `Action { actionId: data.custom_id, value: data.values?.join(",") }`,
   acknowledged before the offer with `POST /interactions/{id}/{token}/callback`
   `{ type: 6 }` (deferred update, nothing visible), the twin of Telegram's
   `answerCallbackQuery`. Other interaction types are ignored in v1.
8. **`Reaction`.** `MESSAGE_REACTION_ADD` only. `emoji` is `emoji.name` for
   unicode, `name:id` for custom. Reactions from the bot itself are dropped.
9. **Text out.** Markdown, verbatim, no parse mode. Every post and edit
   carries `allowed_mentions: { parse: [] }` so model output cannot ping
   anyone; `replyTo` becomes `message_reference: { message_id,
fail_if_not_exists: false }`. `limits = { maxText: 2000, maxCaption: 2000 }`;
   `post` splits with `splitForLimit`, reply on the first chunk, id of the
   last, as on Telegram.
10. **Media out.** `bytes` and `base64` upload as multipart: `files[0]` plus
    a `payload_json` part with the message fields (caption as `content`).
    A `url` source with an `image/*` mime is sent as
    `embeds: [{ image: { url } }]`; any other URL goes as `content`, which
    Discord unfurls. Editing a media message is `MessengerUnsupported`.
11. **`react`.** `PUT /channels/{c}/messages/{m}/reactions/{emoji}/@me`,
    unicode URL-encoded, custom as `name:id`. A 400 "Unknown Emoji" maps to
    `MessengerUnsupported`.
12. **`typing`.** `POST /channels/{c}/typing`, first send awaited, then every
    8 s with `Effect.schedule` until the scope closes.
13. **`raw`.** Payload `{ method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
path: string, body?: unknown }` against the API base. For `post`, the
    response must carry an `id`.
14. **Rate limits, v1 reactive.** A 429 becomes `MessengerRateLimited` with
    `retryAfter` from the body's `retry_after` (seconds, float). No client-side
    bucket tracking yet; `streamViaEdits` and the 1.2 s default absorb the
    edit bucket. Header-driven buckets are a follow-up.
15. **Errors.** Any other non-2xx is `MessengerRequestFailed` with Discord's
    `message` and `code` in `raw`. Gateway close codes are classified by a
    pure function that is unit tested.
16. **Tests.** Pure tests for `events.ts` (addressed rule per source, mention
    stripping, bot authors dropped, thread ref, component action, custom and
    unicode reactions) and for close-code classification. Live test in
    `integration-tests/discord` behind `DISCORD_BOT_TOKEN` and
    `DISCORD_TEST_CHANNEL` (`describe.skipIf`): post, edit, react, typing,
    and a streamed message. No fake-socket state-machine test unless it
    asserts something the pure classifier cannot.
17. **Recipe and docs.** `recipes/messenger-agent/app.ts` gains
    `--messenger telegram | discord`, selecting the layer and the persona's
    formatting line (Telegram HTML or markdown); the recipe file does not
    change. Add `docs/messenger/providers/discord.md` (setup: create app,
    bot token, invite URL with `bot` scope and the intent toggle, one
    instance per token), a Discord row in `docs/providers/index.md` and the
    Messenger overview provider list, the landing-page provider entry, the
    sidebar, the SKILL row, and the changeset (fixed group, debut at the
    current version).

**What does not map, and why it does not change the capability.**
`Command.args` is a string while slash options are typed, and
`Action.value` is one string while a select returns `values[]`: both are
lossy only for features deferred to the slash-command follow-up, and `raw`
carries the full payload meanwhile. Ephemeral replies and "respond to this
interaction" have no verb; that is the webhook duality parked in phase 2. A
URL cannot be a Discord attachment; the embed fallback is adapter-internal.

## Follow-ups

- **Discord slash commands.** Registration (`PUT
/applications/{app}/guilds/{guild}/commands` for instant propagation) from
  a `commands` config, `type: 2` interactions as `Command`, and the
  3 s interaction response, which is where `Command.args` may want to become
  structured. Depends on deciding how a reply to an interaction relates to
  `post`.
- **Discord header-driven rate-limit buckets.** Track `X-RateLimit-Bucket`,
  `Remaining` and `Reset-After` per route and major parameter, delaying
  before a 429 instead of after.
- **Inbound attachments.** A user sending the bot a picture arrives on
  Telegram and Discord alike as `raw` only. With multimodal models this is
  the next ask: `Message.media?: ReadonlyArray<MediaSource>`, with Telegram's
  `getFile` URL and Discord's attachment URL behind it. Generic, not
  platform-specific; not needed to ship Discord.
- **Author display name.** Both platforms deliver it and a multi-user chat
  wants "Alice: …" in history; today it is in `raw`. A `Message.authorName?`
  is the smallest generic addition.

- **Let `loop` bodies use `Scope` without `Stream.unwrap`.** `loop` already
  runs each body in its own iteration scope (it wraps an `Effect` body in
  `Stream.unwrap` and pulls it inside `bodyScope`), but `LoopBody`'s effect
  variant is typed `Effect<Stream, E, R>` with no `Scope`, so a body that
  acquires `typing` or forks a delivery fiber has to wrap itself in
  `Stream.unwrap(...)` to keep `Scope` out of the loop's `R`. Widening the
  type to `Effect<Stream<Step<A, S>, E, R>, E, R | Scope.Scope>` (same for
  `LoopOverBody`) compiles across core and recipes with no other change and
  lets the messenger recipe return the `Effect.gen` directly. Verified on
  2026-09-07, not applied: `Loop` is a public signature and deserves its own
  changeset and a test that pins the per-iteration release.
