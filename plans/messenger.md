# Plan: Messenger capability (Discord / Slack / ... agents)

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
streaming, tool-using agent that lives in a Discord or Slack channel in a few
dozen lines of Effect, with the loop, tools, and history it already has.

The tag is called `Messenger` (not `Chat`, which collides with
`effect/unstable/ai/Chat`, the LLM-conversation abstraction, and reads as the
agent rather than its channel).

Unification is honest here, unlike agent-memory services (which do not reduce
to a shared interface and were rejected on those grounds). What varies between
Discord, Slack, and Telegram is plumbing, not product: five outbound verbs and
one tagged inbound stream cover the shared 80%, and a `raw` escape hatch
carries the rest without lying about it.

## Scope

**v1 (this plan):**

- Core `Messenger` capability tag: one inbound `Stream<InboundEvent>`, five
  outbound verbs (`post`, `edit`, `react`, `typing`, `ephemeral`), branded ids.
- Ambient conversation targeting: `CurrentConversation` in `R`, established
  with `inConversation(ref)`.
- `Turn.toMessages` in core: project the loop's `InteractionEvent` stream onto
  coalesced, edit-in-place message updates.
- Official adapter set is four platforms and no more for now: **Discord, Slack,
  Telegram, WhatsApp**. That is where the users are; everything else (Teams,
  Google Chat, GitHub, Linear, ...) is out of scope at this stage and not worth
  the maintenance surface. v1 ships the three that fit a persistent connection,
  testable from a laptop with no public HTTP endpoint: `@effect-uai/discord`
  (gateway websocket), `@effect-uai/slack` (Socket Mode), `@effect-uai/telegram`
  (long-poll `getUpdates`). WhatsApp is webhook-only (Cloud API), so it waits on
  webhook mode and lands in phase 2 (see deferred).
- A multi-tenant messaging-agent recipe (mention -> streamed answer, tools,
  per-thread history). Orchestration is the recipe's, never the library's.

**Deferred (say so in docs, do not build yet):**

- **Webhook mode, now the defined phase 2** (not an indefinite "someday"),
  because WhatsApp (Cloud API) is webhook-only and Telegram optionally supports
  webhooks too. HTTP webhooks must answer on the same request within a deadline
  (Discord interactions: ~3s or defer), inverting the "event stream +
  fire-and-forget actions" model into "one event, respond inline". That duality
  is the genuinely hard design problem of the domain, so v1 stays
  long-lived-process only; webhook mode is the first work after v1 and is what
  unlocks the WhatsApp adapter.
- Rich card unification beyond a minimal card (title, text, fields, buttons).
  Discord embeds, Slack Block Kit, Telegram inline keyboards stay behind the
  `raw` escape hatch.
- Non-target platforms (Teams, Google Chat, GitHub, Linear, ...). The adapter
  contract is deliberately tiny so the community can add these if they want, but
  we are not shipping or maintaining them. The official set is the four above
  (Discord, Slack, Telegram, WhatsApp) and stops there for now.
- Voice channels (that is the Realtime capability's territory).
- An `ask` helper (post a question, resume the loop on the user's reply). It
  falls out of `InteractionTool` + pause/resume + the inbound stream, but v1
  proves the shape in the recipe before core grows API.
- **Interactive buttons (and approval-over-buttons) are a niche recipe, not v1
  core.** All four platforms support buttons, but the component models diverge
  (Discord components, Slack Block Kit, Telegram inline keyboards, WhatsApp
  reply buttons), so button flows do not unify the way text does. Approval over
  buttons is just `Approval.fromQueue` fed by `Action` events (decision 4), so
  it needs no new core, only the per-platform button rendering.

## Package layout

```
packages/core/src/messenger/
  Messenger.ts         # tag, ids, InboundEvent, Outbound, CurrentConversation, inConversation
  MessengerError.ts    # tagged errors + describe
  Messages.ts          # Turn.toMessages projection (exported via Turn-adjacent docs)
packages/providers/discord/     # v1: gateway websocket
  src/Gateway.ts       # layer({ token }): Layer<Messenger> over the gateway websocket
  src/internal/...     # gateway protocol: identify, heartbeat, resume, REST for post/edit
packages/providers/slack/       # v1: Socket Mode
  src/SocketMode.ts    # layer({ botToken, appToken }): Layer<Messenger>
  src/internal/...
packages/providers/telegram/    # v1: long-poll getUpdates
  src/LongPoll.ts      # layer({ token }): Layer<Messenger>
  src/internal/...
packages/providers/whatsapp/    # phase 2: Cloud API, needs webhook mode
  src/Webhook.ts       # layer({ ... }): Layer<Messenger>
  src/internal/...
```

Core carries zero platform logic; adapters carry zero AI logic. The `Messenger`
tag is the seam.

## Key design decisions

### 1. The service: five verbs + one event stream

```ts
type ChannelId = Brand.Branded<string, "ChannelId">
type MessageId = Brand.Branded<string, "MessageId">
type UserId = Brand.Branded<string, "UserId">

type ConversationRef = { readonly channel: ChannelId; readonly thread?: string }
type MessageRef = { readonly conversation: ConversationRef; readonly id: MessageId }

type InboundEvent = Data.TaggedEnum<{
  Message: {
    conversation: ConversationRef
    id: MessageId
    author: UserId
    text: string
    mention: boolean
  }
  Reaction: { conversation: ConversationRef; message: MessageId; emoji: string; author: UserId }
  Command: {
    conversation: ConversationRef
    name: string
    args: Record<string, string>
    author: UserId
  }
  Action: { conversation: ConversationRef; actionId: string; value?: string; author: UserId }
}>

type Outbound = string | { text?: string; card?: Card } | { raw: unknown }

export type MessengerService = {
  readonly events: Stream.Stream<InboundEvent, MessengerError>
  readonly post: (msg: Outbound) => Effect.Effect<MessageId, MessengerError, CurrentConversation>
  readonly edit: (msg: MessageRef, next: Outbound) => Effect.Effect<void, MessengerError>
  readonly react: (msg: MessageRef, emoji: string) => Effect.Effect<void, MessengerError>
  readonly typing: Effect.Effect<void, MessengerError, CurrentConversation>
  readonly ephemeral: (
    user: UserId,
    msg: Outbound,
  ) => Effect.Effect<void, MessengerError, CurrentConversation>
}

export class Messenger extends Context.Service<Messenger, MessengerService>()(
  "@betalyra/effect-uai/Messenger",
) {}
```

Deliberately absent: `stream` (derived: one `post`, then `edit` on a coalesced
schedule, driven by `Turn.toMessages`), any per-conversation loop, any debounce.
Five primitive verbs keep a new adapter tractable and keep policy out of
transport. `edit`/`react` take an explicit `MessageRef` (you can only edit a
message you can name); the conversation-targeting verbs are ambient (next
decision).

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
precedent. The reason it fits messaging specifically: the conversation target
must reach _deep_ code. A tool's `run` posting "searching..." progress, an
approval resolver posting buttons, an interaction prompt: all live layers below
the handler. Ambient context means the recipe wraps each conversation fiber once
(`inConversation(ref)`) and every nested post lands correctly with no ref
threading. A `Tag` (no default) rather than a `Reference`: posting outside an
established conversation is a compile error, which is a safety property.

Multi-conversation work (proactive broadcast, escalation to an ops channel) is
re-scoping, not a second API:

```ts
yield * messenger.post("On it, escalating.") // ambient: the user's thread
yield * inConversation(onCall)(messenger.post(summary)) // re-scoped: the ops channel
```

No `postTo` in v1; add it as sugar only if the re-scope reads noisily in real
recipes.

### 3. `Turn.toMessages`: the output projection (core, adapter-independent)

The sibling of `Turn.toSSE` / `Turn.toJSONL`, and the one piece that belongs in
core no matter where adapters live, because it frames _model output_:

```ts
// Stream<InteractionEvent> -> Stream<MessageAction>, coalesced for edit-in-place
Turn.toMessages: (opts?: {
  every?: Duration.Input        // min interval between edits (platform rate limits)
  minChars?: number             // or a growth threshold
  showTools?: boolean           // render tool calls as status lines
}) => (events: Stream<Turn.InteractionEvent>) => Stream<MessageAction>

type MessageAction = Data.TaggedEnum<{
  Post:   { msg: Outbound }                    // first content -> create the message
  Edit:   { msg: Outbound }                    // coalesced deltas -> edit it in place
  Status: { text: string }                     // tool call -> status line, later edited
  Settle: { msg: Outbound }                    // final turn -> final content
}>
```

Messaging platforms rate-limit edits and want debounced, batched updates, not
token-by-token SSE. Debounce/coalesce of a delta stream is exactly the
library's Stream wheelhouse. A tiny `render` helper in the recipe executes
`MessageAction`s against `post`/`edit` (tracking the `MessageId` from the first
`Post`).

### 4. Approval is `Approval.fromQueue`, not a new primitive

There is no `Approval.fromMessenger`. Approve/deny-over-buttons is just
`Approval.fromQueue` with two thin recipe pieces around it, because the
verdict-delivery mechanism (a queue keyed by `call_id`, with a timeout) is
already exactly what `fromQueue` is:

```ts
const verdicts = yield * Queue.make<Verdict>()
const approval = Approval.fromQueue(verdicts, { timeout: "5 minutes" })
// recipe piece 1: when a gate opens, post the approve/deny buttons to the conversation
// recipe piece 2: on an `Action` event, decode `approve:<id>` / `deny:<id>`
//                 and Queue.offer(verdicts, ...)
```

Adding a named `Approval.fromMessenger` would be a provider-specific wrapper over
a generic helper we already have. So approval over buttons is a recipe, kept out
of v1 for two reasons: it needs no new core, and interactive components do not
unify across platforms anyway (Discord components, Slack Block Kit, Telegram
inline keyboards, WhatsApp reply buttons), so the button-rendering half is
per-platform work. Keeping it out of v1 is why the basic recipe (appendix) needs
no `Action` demux and no second inbox: text in, streamed text out.

### 5. Providers: a `Layer` owning a scoped gateway connection

Exactly the CDP shape: `discord({ token })` returns
`Layer<Messenger, MessengerError>`; building the layer opens the gateway
websocket (identify, heartbeat, resume), scope close tears it down. The realtime
socket learnings apply verbatim: `closeCodeIsError` whitelisting clean close
codes, reader fiber feeding a `Queue<InboundEvent, Cause.Done>` ended with
`Queue.end` (never `Queue.shutdown`). Outbound verbs use the platform REST API;
tokens are `Redacted` end to end.

Discord ships first: pure websocket gateway, no public HTTP endpoint needed, so
it is the easiest to develop and test end to end. Slack second via Socket Mode,
Telegram third via long-poll `getUpdates`, all three the same
persistent-connection shape. WhatsApp is webhook-only and comes in phase 2 with
webhook mode.

### 6. Orchestration is a recipe

The library never owns the router. The recipe (docs + runnable) is explicit
queues and forked fibers, in the house style:

- A `Ref<HashMap<ChannelId, Queue<InboundEvent, Cause.Done>>>` of inboxes.
- On first message in a conversation: create the inbox, fork one
  agentic-loop fiber wrapped in `inConversation(ref)` (`Effect.forkScoped`).
- A dispatch loop: `Stream.runForEach(messenger.events, route)`.
- Inside each fiber: the agentic-loop recipe unchanged (debounce bursts, one
  batch per clean turn, history as loop state), with `Turn.toMessages` +
  `render` as the sink, and mid-stream abort wired to a new message arriving or
  a stop button.

Per-thread durable history (load state on first message, save after each clean
turn) composes here when a persistence seam exists; the messaging agent is the
concrete use case that motivates it.

### 7. Errors (`MessengerError.ts`)

Tagged family, `describe`-able, mirroring `BrowserError`:

- `MessengerConnectFailed` (gateway/auth failure on layer build or resume).
- `MessengerTransportClosed` (connection dropped; the events stream fails with
  it).
- `MessengerRequestFailed` (an outbound verb rejected: permissions, unknown
  channel, message too long; carries provider `reason` + `raw`).
- `MessengerRateLimited` (carries `retryAfter: Duration`; adapters surface it
  typed so recipes can `Effect.retry` deliberately rather than adapters retrying
  silently).

## Sequencing

1. **Core `Messenger.ts` + `MessengerError.ts`** (tag, ids, events enum, verbs,
   ambient targeting) + a `MockMessenger` test layer (scripted inbound, recorded
   outbound).
2. **`Turn.toMessages`** against existing `Turn.InteractionEvent`s, tested on the
   mock layer. Pays off independently of any adapter.
3. **`@effect-uai/discord`**: gateway connect/heartbeat/resume, the five verbs
   over REST, mention events. End-to-end: mention-triggered streaming reply.
4. **The multi-tenant recipe** (router + per-conversation agentic loop) in docs,
   runnable against mock and Discord.
5. **`@effect-uai/slack`** (Socket Mode) then **`@effect-uai/telegram`**
   (long-poll), each reusing everything above unchanged; three persistent
   transports on one `Messenger` tag is the proof the abstraction holds.
6. Docs section + changesets + skill note.
7. **Phase 2**: webhook mode, then **`@effect-uai/whatsapp`**; and the
   approval-over-buttons recipe (`Approval.fromQueue` fed by `Action` events)
   once per-platform button rendering is done.

## Testing

- `MockMessenger` layer: a scripted `events` stream + a `Ref` log of outbound
  calls. All bridge and recipe tests run against it; no network.
- `Turn.toMessages`: delta bursts coalesce per `every`/`minChars`; tool calls
  produce `Status` then edits; the final turn `Settle`s; empty turns post
  nothing.
- Ambient targeting: `expectTypeOf` that `messenger.post` without
  `inConversation` fails to compile; re-scoping targets the inner conversation.
- Adapter integration tests behind env-gated tokens (the providers' pattern for
  live tests).

## Risks / open questions

- **Adapter maintenance is the real cost.** Platform APIs churn. Contained by:
  five-verb contract, a fixed four-platform official set (Discord, Slack,
  Telegram, WhatsApp) rather than an open-ended list, `raw` escape hatch instead
  of chasing card dialects, and a documented adapter contract so community
  adapters do not become our surface.
- **Webhook mode pressure.** Serverless users will ask immediately. The docs
  must state the v1 boundary plainly (persistent process required) and the
  deferred design must not be foreclosed by v1 choices; keeping the service
  free of connection-lifecycle methods (the Layer owns it) is what keeps the
  door open.
- **Coalescing tuning.** `Turn.toMessages` defaults (interval, growth threshold)
  need empirical tuning against Discord/Slack edit rate limits; ship
  conservative defaults and expose the knobs.
- **Thread semantics differ** (Discord threads vs Slack thread_ts vs Telegram
  replies). `ConversationRef.thread` is an opaque provider-interpreted string
  on purpose; verify it carries all three without leaking platform meaning
  into core.

## Appendix: what a basic integration looks like

The point of this appendix is the _shape_, not every line: a web-search agent
that answers when mentioned. It shows how the library pieces (the `Messenger`
tag, `Turn.toMessages`) and the recipe pieces (the router, the per-conversation
loop) fit together. Internals that are someone else's recipe (the debounce, the
exact `streamTurn` signature) are elided with a comment. Approvals and other
button flows are a separate niche recipe (see decision 4), deliberately left out
here.

### The three moving parts

1. **A tool** (web search).
2. **The per-conversation loop**: the agentic-loop recipe, wrapped in
   `inConversation(ref)`, sinking output through `Turn.toMessages`.
3. **The router**: fans inbound `Message` events out to one inbox per
   conversation; **`main`** composes the layers and runs it.

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

One fiber per conversation, reading from its own `inbox`. Everything runs inside
`inConversation(ref)` so `messenger.post` and `messenger.typing` land in this
conversation without threading a ref through `streamTurn` or the tool.

```ts
const conversation = (ref: ConversationRef, inbox: Queue.Queue<InboundEvent, Cause.Done>) =>
  Effect.gen(function* () {
    const messenger = yield* Messenger
    const history = yield* Ref.make<ReadonlyArray<HistoryItem>>([])

    // the agentic loop: one debounced batch per clean turn
    yield* Effect.forever(
      Effect.gen(function* () {
        const batch = yield* drainDebounced(inbox) // take + coalesce typing bursts (agentic-loop recipe)
        yield* Ref.update(history, appendUserMessages(batch))
        yield* messenger.typing

        // one model turn; the model may call `search`, whose result feeds the next turn
        const turn = yield* streamTurn({ history: yield* Ref.get(history), toolkit }).pipe(
          Turn.toMessages({ every: "600 millis" }), // deltas -> coalesced edits
          renderMessages(messenger), // executes Post/Edit/Settle via messenger.post / messenger.edit
        )
        yield* Ref.update(history, appendTurn(turn))
      }),
    )
  }).pipe(inConversation(ref)) // <- the ambient target for every post/typing below this point
```

The two things that make this integrate cleanly: `inConversation(ref)` puts the
target in `R` so deep code (a tool posting progress) needs no ref, and
`streamTurn` is the ordinary loop primitive, unaware it is speaking to Discord.

### 3. The router and `main`

```ts
const router = Effect.gen(function* () {
  const messenger = yield* Messenger
  const inboxes = yield* Ref.make(HashMap.empty<ChannelId, Queue.Queue<InboundEvent, Cause.Done>>())

  const inboxFor = (ref: ConversationRef) =>
    Effect.gen(function* () {
      const found = HashMap.get(yield* Ref.get(inboxes), ref.channel)
      if (Option.isSome(found)) return found.value
      const inbox = yield* Queue.make<InboundEvent, Cause.Done>()
      yield* Ref.update(inboxes, HashMap.set(ref.channel, inbox))
      yield* conversation(ref, inbox).pipe(Effect.forkScoped) // tied to the connection scope
      return inbox
    })

  // route each mention to its conversation's inbox
  yield* Stream.runForEach(messenger.events, (event) =>
    event._tag === "Message" && event.mention
      ? Effect.flatMap(inboxFor(event.conversation), (inbox) => Queue.offer(inbox, event))
      : Effect.void,
  )
})

router.pipe(
  Effect.scoped, // the discord layer's gateway websocket lives for this scope
  Effect.provide(discord({ token: Redacted.make(process.env.DISCORD_TOKEN!) })),
  Effect.provide(OpenAILayer),
  Effect.provide(WebSearch.layer(/* ... */)),
  Effect.runFork,
)
```

Swapping Discord for Slack is one line: `Effect.provide(slack({ ... }))`. The
tool, the loop, the router, and `Turn.toMessages` are all untouched, which is
the whole claim of the capability made concrete.

### What the user sees

They @-mention the bot with a question; it starts typing, runs a web search if
it needs one, then streams its answer into one edited message.
