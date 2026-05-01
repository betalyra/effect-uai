# WebSocket transport — a unified shape for OpenResponses and Gemini Live

## Goal

Both providers we care about now expose a persistent-WebSocket transport
that promises lower per-turn latency than HTTP+SSE. Pick a shape that
fits both and slots into the existing
[Loop primitive](../packages/core/src/loop/Loop.ts) and
[`LanguageModelService`](../packages/core/src/language-model/LanguageModel.ts)
without forking the recipe surface for HTTP vs WS.

References:

- [openresponses.org WebSocket transport](https://www.openresponses.org/specification#websocket-transport)
- [Gemini Live API](https://ai.google.dev/api/live)

## The two protocols at a glance

|                          | OpenResponses WS                                                                | Gemini Live (BidiGenerateContent)                                                                |
| ------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Endpoint                 | `wss://.../v1/responses` (same resource as HTTP)                                | `wss://generativelanguage.googleapis.com/ws/.../BidiGenerateContent`                             |
| Auth                     | Same headers as HTTP                                                            | Ephemeral token via `?access_token=` or `Authorization: Token <value>`                           |
| Setup phase              | None. First frame is `response.create`.                                         | Required. `BidiGenerateContentSetup` (model, system, tools, generationConfig) → `SetupComplete`. |
| Turn start               | Client emits `{type: "response.create", ...}`                                   | Client emits `ClientContent` with `turnComplete: true`.                                          |
| Per-turn model/tool overrides | Yes. Each `response.create` sets its own model, tools, etc.                | No. Model/tools are baked into the session at setup.                                             |
| Server frames            | Same SSE event objects, raw JSON (no `data:` framing).                          | `ServerContent` (with `modelTurn`, `generationComplete`, `turnComplete`, `interrupted`).         |
| Tool-call protocol       | `response.completed` carries calls; client opens a new `response.create` with `function_call_output` items as input. | `ToolCall` frame mid-stream; client replies with `ToolResponse` on the **same** stream; generation resumes. Server may also emit `ToolCallCancellation`. |
| Concurrency              | One in-flight response per connection. Explicit.                                | Implied single logical turn; new client content interrupts current generation.                   |
| Cancellation             | Undocumented. Effective only by closing the socket → cache eviction.            | Send any `ClientContent` while generating → server emits `interrupted: true`, no `generationComplete`. |
| Session continuation     | `previous_response_id` → connection-local cache. Lost on reconnect.             | `SessionResumptionUpdate.newHandle` → server-managed, survives reconnect (in-process or not).    |
| Disconnect signal        | Hard error `websocket_connection_limit_reached` at 60 min.                      | `GoAway` frame with `timeLeft` Duration before terminating.                                      |
| Keepalive / ping         | Not specified.                                                                  | Not specified beyond standard WS.                                                                |
| Context window mgmt      | Not specified.                                                                  | Optional `ContextWindowCompressionConfig` with sliding window.                                   |

## What's structurally common

Both reduce, for our purposes (text + tools, no audio), to:

1. **Establish.** Open a socket. Optionally do a setup handshake.
2. **Per turn.** Send a frame describing the new user/tool input. Receive
   a stream of text-delta-equivalents. Receive a turn-complete-equivalent
   (with stop reason, usage, tool calls).
3. **Sometimes.** Tool calls during/after a turn. The protocols disagree
   on whether tool responses are part of the same turn-stream (Gemini)
   or kick off the next one (OpenResponses).
4. **Lifetime.** The connection ages out (60 min hard / `GoAway`
   advance notice). Resumption exists, semantics differ.
5. **Single logical generation in flight.** Either explicitly
   (OpenResponses) or by interruption-on-new-content (Gemini).

## What's incompatible

- **Setup.** Gemini binds model/system/tools to the session; OpenResponses
  rebinds them per turn. Any unified API has to either (a) accept the
  Gemini-style restriction by locking these at session creation, or (b)
  trigger a teardown+resetup on Gemini whenever they change — losing the
  win.
- **Tool-call shape.** Gemini's mid-turn `ToolCall` + `ToolResponse`
  exchange is a different shape than the existing
  `Turn.functionCalls(turn)` → next-iteration model. We can buffer
  Gemini's `ToolCall` frames into the assembled `Turn` and synthesize
  the next-iteration shape, at the cost of losing Gemini's "generation
  resumes immediately after tool response" optimization.
- **Resumption portability.** Gemini handles survive process restart;
  OpenResponses' cache is connection-local. We can only offer
  "in-process reconnect-and-resume" as a portable feature.
- **Cancellation cost.** Interrupt is cheap on Gemini (stay on the
  socket), expensive on OpenResponses (close → lose cache → cold-start
  next turn).

## Constraints from our current code

- [`LanguageModelService.streamTurn(history, options)`](../packages/core/src/language-model/LanguageModel.ts)
  is **stateless per call**. Recipes that don't use WS shouldn't have to
  change — including the test
  [LanguageModelService](../recipes/mid-stream-abort/index.test.ts) used
  in recipe tests.
- The [Loop primitive](../packages/core/src/loop/Loop.ts) is
  pull-based and scope-friendly. Anything we add must preserve the
  property that closing the outer scope tears down the active
  iteration's resources (so [mid-stream
  abort](../recipes/mid-stream-abort/index.ts) keeps working).
- Provider [Config](../packages/providers/responses/src/Responses.ts) already
  carries `apiKey: Redacted.Redacted` and `baseUrl?: string`. We don't
  want to fork that for WS-mode; same Config should configure either
  transport.

## Design options

### Option A — Pooled drop-in WS layer

Same `Responses` / `Gemini` service tags. Same `streamTurn` signature.
Layer hides a pool of WS connections. Each `streamTurn` call leases a
socket, runs one turn, returns the socket.

- ✅ Zero recipe changes. `responsesWsLayer({ apiKey, model })` is a
  drop-in for `responsesLayer`.
- ✅ Per-turn model/tool overrides are fine for OpenResponses.
- ❌ Loses `previous_response_id` caching unless we add sticky routing
  per logical conversation. Sticky routing needs a key — and the
  existing API has nowhere to put one (state is the loop's, not the
  provider's).
- ❌ Doesn't fit Gemini at all. Gemini's setup is per-session; pooling
  sockets means re-setup on lease, which is at least one round-trip
  before any text. Throws away the win.
- ❌ Mid-stream interrupt on a leased socket means closing the socket
  (we can't safely return a half-used one to the pool), so we churn
  through connections.

Verdict: works for OpenResponses, bad for Gemini, doesn't capture the
caching benefit either provider offers.

### Option B — Explicit Session, scoped to the loop

Add a `Session` shape on each provider:

```ts
interface ResponsesSession {
  readonly streamTurn: (history, options) => Stream<TurnDelta, AiError>
}

namespace Responses {
  const session: (overrides?: SessionOverrides) => Effect<ResponsesSession, AiError, Scope>
}
```

The recipe yields a session and threads it through the loop:

```ts
Effect.scoped(Effect.gen(function* () {
  const session = yield* Responses.session()
  yield* Stream.runForEach(
    pipe(initial, loop((state) =>
      session.streamTurn(state.history, {}).pipe(streamUntilComplete(...))
    )),
    consume,
  )
}))
```

Internally:

- **OpenResponses session** — owns one WS, internal `Semaphore.make(1)`
  to enforce single-flight, auto-fills `previous_response_id` from the
  last completed turn so the on-server cache is exercised. Reconnect on
  60-min limit replays from `previous_response_id` (transparent).
- **Gemini session** — owns one WS, sends `Setup` at session start with
  `model` + `tools` + `systemInstruction` from a `SessionConfig`,
  awaits `SetupComplete`, then per `streamTurn` call:
  - First call (or after a tool roundtrip): pack the new user message
    into `ClientContent` with `turnComplete: true`. Stream `ServerContent`
    deltas out, accumulate `ToolCall` frames, emit `turn_complete` when
    the assembled turn is done.
  - Tool roundtrip: when the next `streamTurn(history, ...)` arrives
    and the last `Turn` had tool calls, detect the new
    `function_call_output` items and emit `ToolResponse` frames instead
    of a fresh `ClientContent`.
  - Reconnect on `GoAway` using `SessionResumptionUpdate.newHandle`
    (transparent).

Pros:

- ✅ Fits both protocols. Each provider session absorbs its own quirks.
- ✅ Lifetime is in the type system (`Scope`), and matches the
  loop's natural scope. `previous_response_id` / Gemini handle caching
  is the default, not opt-in.
- ✅ Single-flight is enforced at the session, which is the right grain.
- ✅ Recipes that don't use WS keep `streamTurn` directly — no
  migration.
- ✅ HTTP-mode session can be a trivial pass-through that just delegates
  to the existing per-call `streamTurn`. Same recipe code runs on
  either transport.

Cons:

- ❌ Recipes using WS get one extra layer of nesting (`Effect.scoped` +
  `yield* session`).
- ❌ Gemini setup locks model/tools per session. Loops that vary tools
  per turn would need either re-setup (slow) or to declare the union
  upfront. **I think this is acceptable** — varying tools per turn is
  rare; varying model usually means a different conversation anyway.
- ❌ Tool-call buffering on the Gemini side hides the speedup of "tools
  resolve and generation resumes on the same socket without a fresh
  client message." We get the wire speed-up but not the streaming
  speed-up.

Verdict: best fit. Captures the gains from both providers, keeps recipes
single-shape.

### Option C — Bidirectional Session with tool-response in-band

Same as B, but `streamTurn` returns a richer object that lets the
consumer push tool responses back without ending the stream:

```ts
interface BidiTurn {
  readonly deltas: Stream<TurnDelta, AiError>
  readonly respondToTools: (outputs: FunctionCallOutput[]) => Effect<void>
}
```

- ✅ Models Gemini's mid-turn tool-response shape natively. No
  buffering tricks; full speedup.
- ❌ OpenResponses has to emulate by closing the deltas stream when a
  tool call lands and starting a new `response.create` under the hood.
  We're back to needing a sticky session.
- ❌ The loop body has to know which API it's talking to or use a new
  primitive that subsumes `streamUntilComplete`. Recipes change.
- ❌ Bigger API surface, harder to reason about for the common case
  (no tools).

Verdict: too much weight for the marginal Gemini gain. Worth keeping in
mind as a v2 if Gemini's mid-turn-resume turns out to be a bigger
latency win than estimated.

### Option D — Provider-typed sessions, no unification

Each provider exposes its own session type with provider-specific
methods. We don't pretend they're the same.

- ✅ Honest.
- ❌ Recipes branch.
- ❌ The HTTP/WS swap stops being free.

Verdict: only worth it if B turns out to leak the differences badly.

## Recommendation

**Option B.** Concretely:

1. Add `LanguageModelSession` to core as a scoped, single-flight
   `streamTurn` shape:

   ```ts
   interface LanguageModelSession {
     readonly streamTurn: (
       history: ReadonlyArray<Item>,
       options?: CommonRequestOptions,
     ) => Stream<TurnDelta, AiError>
   }
   ```

   No setup config in the core type — provider-specific session config
   stays on the provider's typed session.

2. On each provider, add `session(config?)`:

   ```ts
   namespace Responses {
     export const session: (
       overrides?: { reasoning?: ResponsesRequestOptions["reasoning"]; store?: boolean }
     ) => Effect<ResponsesSession, AiError, HttpClient.HttpClient | Scope>
   }

   namespace Gemini {
     export const session: (
       config: { systemInstruction?: string; tools?: Tool[]; thinkingBudget?: number }
     ) => Effect<GeminiSession, AiError, HttpClient.HttpClient | Scope>
   }
   ```

3. **HTTP-mode sessions** are pass-throughs: `session()` returns an
   object that just delegates to the existing per-call `streamTurn`.
   Same recipe code runs on either transport; users opt into WS by
   swapping `responsesLayer` for `responsesWsLayer`.

4. **WS-mode sessions** own the connection. Reconnect, single-flight,
   id/handle caching are all internal. Errors from the wire surface
   through `streamTurn` as the existing `AiError` variants.

5. **Mid-stream abort.** Closing the session scope closes the socket.
   The existing
   [mid-stream abort recipe](../recipes/mid-stream-abort/index.ts)
   keeps working without changes — only the cost differs by transport
   (free on HTTP, cache-eviction on OpenResponses, cheap on Gemini if
   we wire interrupt-by-new-content; close-and-reopen otherwise).

6. **Migration path for recipes.** None mandatory. WS users wrap their
   loop in `Effect.scoped` + `Responses.session()`. The
   [getting-started](../docs/start/getting-started.md) and
   [basic-usage](../recipes/basic-usage/index.ts) shapes don't change;
   add a "WebSocket session" recipe that demonstrates the wrapper.

## Open questions before implementation

- **Setup-config drift.** Should `Responses.session()` accept the
  per-turn options as session-level defaults (so the `streamTurn` call
  site can stay empty)? Or always require them per call? Leaning
  defaults-with-per-call-overrides.
- **Single-flight policy.** When two fibers concurrently call
  `session.streamTurn`, do we (a) queue, (b) fail-fast, or (c) require
  the user to fork a second session? I'd start with (a) + a debug-level
  log when contention is observed.
- **Reconnect transparency.** OpenResponses 60-min limit and Gemini
  `GoAway` should be invisible to the loop body by default. Surface as
  an `AiError.SessionExpired` only when reconnect itself fails.
- **Gemini tool-set immutability.** Confirm with Gemini API: does
  changing tools require a new session, or can `Setup` fields other
  than `model` actually be re-set during a session resumption? If
  yes, we can lift the "tools fixed for session lifetime" restriction.
- **Subprotocols / auth tokens for Gemini.** The ephemeral-token flow
  needs an `AuthTokenService.CreateToken` call before the WS upgrade.
  Where does that live — inside `Gemini.session()` (one extra HTTPS
  round-trip on session start) or as a separate `Gemini.token` Effect
  the user provides?
- **Smoke-test target.** No real OpenResponses-spec server to test
  against. Decision: build a Vitest-friendly fake server (Node `ws`)
  that implements the documented frames, and gate WS-mode integration
  tests on a real server only when one exists.

## What this plan does not cover

- Audio / video input on Gemini Live. Out of scope until we have a use
  case.
- Multi-session pools / load balancing across sockets. Single session
  per loop is the v1 shape.
- Cross-process session resumption (Gemini handles persisted to disk).
  Possible later, but the v1 session is a process-local resource.
