# Plan — `LlmProvider` redesign: native + canonical streams

Companion to [internal-docs/llm-provider-design.md](../internal-docs/llm-provider-design.md).
This doc compares the brainstorm against the current code, names the concrete
deltas, and flags what probably should _not_ be adopted as-is.

## Decisions

Settled while iterating on this plan:

- The new method on the typed provider service is called **`streamNative`**.
  Returns `Stream<ProviderEvent, AiError>` — the provider's wire vocabulary,
  unprojected. The canonical default stays `streamTurn`, and is implemented
  as `streamNative |> Stream.map(toCanonical)` (or `mapAccum` where the
  projector is stateful). Both methods sit on the same interface, single
  source of truth.
- The escape-hatch event has shape **`{ type: "other"; native: unknown }`**.
  No `provider` field, no `<P>` type parameter. Consumers who want typed
  natives go through `streamNative` directly; the canonical view's `other`
  is for "we saw something but didn't recognize it — payload's there if
  you want to peek".
- The canonical taxonomy is renamed **`TurnDelta` → `TurnEvent`**. "Delta"
  was a stretch — `turn_complete`, lifecycle members, `usage_update`,
  `citation` aren't deltas of anything.
- Reasoning gets **one variant with a kind discriminator**:
  `{ type: "reasoning_delta"; text: string; kind: "trace" | "summary" }`.
  OpenAI Responses emits both kinds as separate wire events; Anthropic and
  Gemini only emit `kind: "trace"`. Nothing is dropped.

## TL;DR

The design's three layers map onto things we already have, partially:

- Native event union per provider — exists, but **internal**, never reaches the user.
- Projector (native → canonical) — exists in the right shape (`mapAccum` / `mapConcat`).
- Per-provider Tag + generic Tag — already paired at `layer` time.
- Canonical taxonomy — exists as `TurnDelta` but is **narrower** than `CommonView`.
- Native stream surfaced to consumers — **missing**. The vendor Tag returns canonical, same as the generic Tag.
- Escape hatch (`Other`) — **missing**. Unknown events are silently dropped at decode.

The bones are there. The missing wiring is (a) lifting per-provider `ProviderEvent`
from internal to public, (b) giving the typed Tag a method that streams natives,
(c) broadening the canonical taxonomy and adding `Other`.

## Where we are today

| Design layer                    | What we have                                                                                                                              | Where it lives                                                                                                                                                                                                   |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native event union per provider | `ProviderEvent` schema per provider, internal artifact.                                                                                   | [packages/providers/responses/src/streamEvents.ts](../packages/providers/responses/src/streamEvents.ts), [packages/providers/anthropic/src/streamEvents.ts](../packages/providers/anthropic/src/streamEvents.ts) |
| Projector                       | `eventToDeltas` (Responses, stateless) and `applyEvent`+`deltasFromEvent` (Anthropic, accumulator).                                       | [responses/streamEvents.ts](../packages/providers/responses/src/streamEvents.ts), [anthropic/Anthropic.ts](../packages/providers/anthropic/src/Anthropic.ts)                                                     |
| Per-provider Tag + generic Tag  | Both registered by `layer`, sharing one impl.                                                                                             | [responses/Responses.ts](../packages/providers/responses/src/Responses.ts)                                                                                                                                       |
| Canonical taxonomy              | `TurnDelta`: `text_delta`, `reasoning_summary_delta`, `tool_call_start`, `tool_call_args_delta`, `turn_complete`.                         | [packages/core/src/domain/Turn.ts](../packages/core/src/domain/Turn.ts)                                                                                                                                          |
| Native stream surfaced          | Not exposed. Typed Tag (`Responses`/`Anthropic`/`Gemini`) returns `Stream<TurnDelta>` — the typed-ness only differs in _request options_. | [responses/Responses.ts](../packages/providers/responses/src/Responses.ts)                                                                                                                                       |
| `Other` escape hatch            | Not present. `Schema.decodeUnknownEffect(ProviderEvent)                                                                                   | > Effect.option` drops unknowns.                                                                                                                                                                                 |

## What would need to change

### 1. Add `streamNative` to the typed provider service

The typed Tags gain a second method returning `Stream<ProviderEvent, AiError>`.
`streamTurn` keeps returning the canonical view.

- Export `ProviderEvent` from each `streamEvents.ts`.
- Extend `ResponsesService` / `AnthropicService` / `GeminiService` with `streamNative`.
- Refactor each provider's HTTP+SSE chain into a shared inner stream;
  `streamTurn = streamNative |> toCanonical`.

Side benefit: each provider's main file currently bundles SSE pipeline +
`mapAccum`-to-delta translation in one block (Anthropic: ~lines 272-305).
Splitting that into "native stream" + "canonical projection" is a readability
win on its own.

### 2. Stop silently dropping unknown events

Two viable shapes:

- Add a `Schema.Unknown`-style fallback variant in each `ProviderEvent` so
  decode always succeeds.
- Or model `ProviderEvent = Tagged | Unknown { type: string; raw: unknown }`
  and let the projector map `Unknown` to the canonical `other` event.

Either way the rule "every native event has an explicit branch" becomes a
typecheck via `Match.exhaustive`, which we already use.

### 3. Rename and broaden the canonical taxonomy

Rename `TurnDelta` → **`TurnEvent`** (single sweep across `domain/Turn.ts`,
all three providers' `streamEvents.ts` and main files, recipes, tests).

Add variants in roughly this order of value:

1. **`reasoning_delta`** with `kind: "trace" | "summary"`. Replaces today's
   `reasoning_summary_delta`. OpenAI emits both kinds; Anthropic and Gemini
   always emit `kind: "trace"`. Today we drop `response.reasoning_text.delta`
   on the floor — this fixes that and ends the misnomer where Anthropic's
   trace was being labelled "summary".
2. **`refusal_delta`** (Tier-1 #3 in [responses-gaps.md](responses-gaps.md)).
3. **`citation`** and **`tool_result`** for server-side built-ins
   (web_search, file_search) — currently invisible.
4. **`usage_update`** mid-stream (today usage only arrives bundled inside
   `turn_complete.turn`).
5. **`cache_info`** (cuttlekit Phase 1).
6. Multimodal **`image_part`** / **`audio_delta`** (Tier-1 #5).
7. **`other`** escape hatch — `{ type: "other"; native: unknown }`.

### 4. Tool-call shape: leave alone

The design's single `ToolCall { argsDelta, done }` collapses our current
`tool_call_start` + `tool_call_args_delta` split. **Don't change this.** The
start event lets consumers commit name/id to UI before any args land, and
existing downstream code depends on the split. Both shapes are fine; not
worth the churn.

## What probably doesn't make sense to adopt as-is

### Replace `turn_complete { turn: Turn }` with a bare `Finish { reason, usage }`

The assembled `Turn` is the contract our `loop` primitive depends on —
`cursor(state, turn)` extends history with `turn.items`
([Turn.ts](../packages/core/src/domain/Turn.ts)), every recipe relies on it.
The design assumes consumers reassemble from per-item events.

**Keep** the terminal `turn_complete` as a _richer_ canonical event than
`CommonView.Finish`, not a replacement. If we followed the spec to the
letter we'd emit a `Finish` mid-stream for reason+usage, then a final
`TurnAssembled` — two events for one boundary, not worth it.

### `CommonView.Error` as a stream value

The design models in-stream errors as values. Effect's stream channel
separates failure from value for a reason: `Stream.catchTag`, `Stream.retry`,
`Stream.scoped` cleanup. Our `AiError` tagged union flowing through
`Stream.fail` is the right channel for transport/HTTP/auth/rate-limit.

**Don't move these to values.** What _could_ fit as a value is a non-fatal
in-stream provider-emitted error (Anthropic ships an SSE `error` mid-stream
for some scenarios). Even there, escalating to `Stream.fail(AiError.Unavailable)`
like we do today is defensible. If we add a value-form `error` event,
it's strictly for non-terminal cases; terminal errors stay in the failure
channel.

### Bytes-or-URL sum type for images, bytes-only for audio (in isolation)

The shape is fine for the canonical view, but our `Items.ContentBlock` is
what matters for round-tripping back to the model. Coordinate the
multimodal event shape with the [responses-gaps.md](responses-gaps.md)
Tier-1 #5 plan so the event type and the historical `ContentBlock` agree.
Do the work there, not as a one-off in `TurnEvent`.

### Native as the _primary_ surface on the typed Tag

The design suggests the typed Tag's `streamTurn` returns native, and
`toCommon` is a downstream transform. **Flip it:** `streamTurn` keeps
returning canonical (the 95% case), `streamNative` for the 5% who want
native fidelity. Same surface area; the common path stays obvious.

### Parameterize the generic service on `<P>`

Dropped. With `other = { type: "other"; native: unknown }` the canonical
boundary doesn't carry vendor type info. Consumers who need typed natives
go through the typed Tag's `streamNative`. The generic
`LanguageModelService` stays non-generic.

## Incremental path

In roughly this order, each step independently shippable:

1. **Export `ProviderEvent` + add `streamNative`.** No taxonomy change.
   Splits the SSE pipeline into "native stream" + existing projector.
   Unlocks the design's `persistAnthropicSignatures`-style use case. Low
   risk, no breaking change.
2. **Add `Unknown`/`other` plumbing.** "No silent drop" becomes a typed
   guarantee.
3. **Rename `TurnDelta` → `TurnEvent`** and land `reasoning_delta` with
   `kind`. One PR; coordinated rename + the first canonical broadening.
4. **Broaden the rest** — `refusal_delta`, `usage_update`, `citation`,
   `cache_info` — gated by recipe demand. Each new variant only forces
   work where consumers want to _handle_ it, because of `Match.exhaustive`
   discipline.
5. **Multimodal + server-side tool results.** Separate effort, joined to
   the multimodal `ContentBlock` extension in
   [responses-gaps.md](responses-gaps.md).

## Implementation notes

- **`streamTurn` is implemented in terms of `streamNative`.** Each provider
  service exposes both methods. `streamTurn` is `streamNative |> Stream.map(toCanonical)`
  (or `Stream.mapAccum` where the projector is stateful, e.g. Anthropic's
  tool-name lookup). This keeps the SSE pipeline single-sourced and means
  `toCanonical` is reachable as a standalone function for testing /
  composition. Both `streamNative` and `streamTurn` live on the typed
  service interface.
- `streamNative` lives on the typed Tag only, not on `LanguageModelService`.
  The generic tag is for portability; native fidelity is by definition
  vendor-aware.
- `Unknown` carries a minimal `type: string` shape so generic-but-curious
  consumers can switch on it without casting. Cheap invariant.
