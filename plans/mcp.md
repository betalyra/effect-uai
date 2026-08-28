# Plan: `@effect-uai/mcp` (Model Context Protocol client)

## Why this first

One adapter unlocks the entire MCP tool ecosystem (filesystem, git, github,
sqlite, slack, and the thousands of community servers) as effect-uai
`Toolkit`s. It is the highest-leverage capability we can ship because the tool
layer was already built to receive it:

- `Toolkit.fromArray` exists specifically for "a dynamically-sourced array
  (MCP server, plugin)" and tolerates MCP's loose naming (dots, names over 64
  chars). Its doc comment names MCP by hand.
- `Toolkit.namespace(prefix, kit)` exists to keep generic names (`search`)
  from two sources distinct before `compose`.
- `Toolkit.run`'s "unknown_tool" graceful path already covers "MCP tools come
  and go" (its comment says so).
- The 0.10 failure model is a clean fit: an MCP `isError` result maps to
  `Tool.fail` (model-visible), a transport/protocol failure maps to a typed
  `McpError` that propagates on `Toolkit.run`'s channel. No new core concepts.

**Net: no `@effect-uai/core` changes.** This is a self-contained provider
package that consumes existing core surface and produces a core `Toolkit`.

## Protocol versions: modern-first, dual-era

> Verified against the published spec on 2026-08-28 (`/specification/2026-07-28/`
> changelog, `basic/versioning`, `basic/transports/streamable-http`). The deltas
> that check corrected are marked **[spec]** throughout this plan.

The spec split into two eras with the **2026-07-28** revision (the "stateless
rewrite," SEP-2575/SEP-2567). The spec defines the vocabulary we adopt
verbatim **[spec]**:

- **Modern**: versions that carry version, identity and capabilities as
  per-request metadata (`2026-07-28` and later).
- **Legacy**: versions that establish a session with an `initialize`
  handshake (`2025-11-25` and earlier).
- **Dual-era**: an implementation supporting both. **This client is dual-era.**

The spec's own compatibility matrix is blunt: a modern-only client against a
legacy server **fails**, with no graceful degradation; only a dual-era client
works against both. Era is a property of the _server_, not of a request, so
the spec directs clients to cache the determination for the lifetime of the
server process (stdio) or origin (HTTP) and re-probe only if the cached
assumption later fails **[spec]**.

Our position, and the reasoning behind it:

- **Primary target: 2026-07-28 (modern, stateless).** The client's core model
  is the modern one: no handshake, no session, pure request/response. This is
  where the protocol is going, it is the simpler design, and for a tools-only
  client it deletes most of the old plan's complexity (session ids, the
  standalone SSE channel, notification demux).
- **Compatibility mode: 2025-06-18 (legacy).** Live probes (2026-08-16) show
  every public no-auth server still on the handshake era: DeepWiki, Microsoft
  Learn, Cloudflare docs, Hugging Face all negotiate 2025-06-18, and the
  reference servers ship on the still-beta TS SDK. A modern-only client could
  talk to almost nothing in the wild today. All official SDKs (TS v2, Python
  2.0, Go, C#) do exactly this dual-era fallback in their clients, so it is
  the expected client behavior. Cost for a tools-only client is medium and
  well-bounded (the deltas are enumerated in design decision 2b below).
- **Not supported: 2025-03-26 and older.** A server that only speaks the old
  HTTP+SSE transport (e.g. GitMCP today) gets a typed
  `McpUnsupportedProtocol` error naming the version it wanted. It is a
  negotiation-failure test target, not a support target.
- 2025-11-25 needs no special handling: it is wire-compatible with the
  2025-06-18 flow for our subset (its additions were icons, tasks, OIDC
  discovery; `initialize` was untouched). Legacy mode negotiates whichever of
  the two the server offers.

The nice inversion versus the pre-rewrite plan: legacy is now the "extra"
mode, isolated behind era detection, and droppable in a future major without
any public API break.

## What effect-smol already gives us

Confirmed present in `effect@4.0.0-beta.57`:

- `effect/unstable/ai/McpSchema` exists (MCP wire schemas: `ContentBlock`,
  `McpError`, the request / result encodings, the JSON-RPC error codes) and
  effect-smol even ships an MCP _server_ in `McpServer`, but there is no MCP
  _client_, which is the gap we fill. We deliberately **do not depend on**
  `McpSchema`: it is an unstable surface shaped for the server (and predates
  the 2026-07-28 rewrite), and we own our wire schema instead (see design
  decision 0). It is listed here only to show the client is genuinely missing.
- `effect/unstable/http/{HttpClient,FetchHttpClient}`: the Streamable HTTP
  transport, the same client the LLM providers already use.
- `effect/unstable/process/ChildProcess`: a scoped `ChildProcessHandle` with a
  `stdin` sink and `stdout` / `stderr` `Stream`s. This is the stdio (local
  subprocess) transport, no `node:child_process` and no `@effect/platform`
  needed.
- `effect/unstable/socket/Socket`: not needed for MCP, but it is the model the
  JSON-RPC client below is copied from (see `providers/browser/src/internal/cdp.ts`).

## Scope

"v1" throughout this plan means **our first `@effect-uai/mcp` release**, not an
MCP protocol version.

Both transports are in our v1: **Streamable HTTP** (remote servers) and
**stdio** (local subprocess servers). Both eras ride both transports. The
transports share the JSON-RPC client and the toolkit layer via the `Transport`
seam (§2), so the second transport is mostly a second
`internal/transport.ts` implementation.

**v1 (this plan):**

- Connect to an MCP server over **Streamable HTTP** or **stdio**, in either
  protocol era, with automatic era detection (design decision 2c) and an
  optional pin.
- Modern era: bare `tools/list` / `tools/call` requests plus one
  `server/discover` at connect. Legacy era: the `initialize` handshake,
  `Mcp-Session-Id`, then `tools/list` / `tools/call`.
- On HTTP, full modern request-metadata conformance: `MCP-Protocol-Version` /
  `Mcp-Method` / `Mcp-Name`, and the `x-mcp-header` -> `Mcp-Param-*` mirroring
  with Base64 sentinel encoding, which the spec makes a client MUST **[spec]**
  (see §3).
- Build a `Toolkit` from the server's advertised tools, one `LocalTool` per MCP
  tool, each calling `tools/call` over the connection.
- Authentication as a first-class seam (§3) on the HTTP transport: a `Static`
  token, a bring-your-own `TokenSource` (any external OAuth plugs in), and
  built-in `OAuth.clientCredentials` (the fully headless OAuth 2.1 grant, with
  RFC 9728 / RFC 8414 discovery). A `401` surfaces a typed `McpAuthRequired`
  carrying the discovery pointer. (stdio servers authenticate via their spawn
  environment, e.g. an API-key `env` var, not this seam.) Auth is era-blind.

**Deferred (note in docs, do not build yet):**

- Resources (`resources/list` / `resources/read`) and prompts
  (`prompts/list` / `prompts/get`). These map to context injection and message
  templates, not the agent-loop tool surface, so they are phase 2.
- Live tool-list refresh. v1 snapshots the tool list at `toolkit()` time (we
  read but do not act on the modern era's `ttlMs` / `cacheScope` list
  metadata; they are the designed input for a later refresh feature). Legacy
  `notifications/tools/list_changed` is likewise ignored. The `unknown_tool`
  path already degrades gracefully if a tool vanishes mid-run.
- Sampling, elicitation and roots. Legacy servers request these as
  server-initiated JSON-RPC requests (we answer with method-not-found,
  decision 2b); modern servers fold them into results as Multi Round-Trip
  Requests, `resultType: "input_required"` (we fail typed, decision 6). Same
  posture in both eras: v1 is a headless tools client. The spec has since
  **deprecated Roots, Sampling and Logging outright** (12-month window)
  **[spec]**, so the phase-2 work here shrank to elicitation-only MRTR.
- The modern `subscriptions/listen` channel (which replaced the GET stream and
  `resources/subscribe`) and the `io.modelcontextprotocol/tasks` extension,
  now negotiated through `capabilities.extensions` rather than living in the
  core protocol **[spec]**. Not needed for request/response tools.
- Interactive OAuth (`OAuth.authorizationCode`: PKCE + user consent + RFC 7591
  dynamic client registration). The redirect / callback capture is an app
  concern, so this waits for a concrete app to shape the callback. Until then a
  human-consent server is reached by passing the token through `TokenSource`.
- Image / audio / embedded-resource content blocks in tool _results_: v1
  serializes text + `structuredContent`; richer blocks are a follow-up once the
  loop has a multimodal tool-output path.

## Package layout

Mirrors `providers/browser` exactly (transport in `internal/`, public surface
at the package root, one export subpath per entry).

```
packages/providers/mcp/
  package.json          # deps: effect (peer), @effect-uai/core (peer). No SDK.
  tsconfig.json
  tsdown.config.ts
  src/
    index.ts            # re-exports Client + Toolkit + errors + Auth types
    Client.ts           # connect(), layer(), the McpClient service tag, Auth type
    Toolkit.ts          # mcpToolkit(client): Effect<Toolkit, McpError>
    OAuth.ts            # OAuth.clientCredentials (v1) / authorizationCode (phase 2) -> TokenSource
    McpError.ts         # public tagged errors (transport / protocol / init / auth / version)
    internal/
      rpc.ts            # JSON-RPC 2.0 client over a Transport (hand-rolled, cdp.ts model)
      protocol.ts       # the `Protocol` interface, the probe type, the era discriminator
      protocols/
        2026-07-28.ts   # stateless: _meta envelope, modern headers, server/discover
        2025-11-25.ts   # re-export of 2025-06-18 (wire-compatible for our subset)
        2025-06-18.ts   # handshake: initialize gate, session echo, inbound ping
      httpTransport.ts  # Streamable HTTP Transport impl (applies Auth; SSE framing; era headers)
      stdioTransport.ts # stdio Transport impl (ChildProcess + JSONL framing)
      auth.ts           # token cache/refresh, WWW-Authenticate + RFC 9728/8414 discovery
      schema.ts         # our own MCP wire schemas (Effect Schema), both eras, self-contained
```

**Files under `protocols/` are named for the spec revision they implement.**
The revision date is the only stable identifier: "modern" ages, and the set of
versions in an era grows. A new revision that keeps an existing wire shape gets
its own file re-exporting the one it matches (as `2025-11-25.ts` does), so the
directory listing alone answers "which versions do we support, and which are
genuinely different?". `Client.ts` imports them under readable aliases, so the
call site reads by mechanism while the file reads by revision.

### One entry point, two era implementations

Era is a runtime property of the _server_, not a compile-time choice of the
app: a developer pointing at a legacy server cannot elect to speak modern to
it, and servers will migrate legacy -> modern one at a time over the next
year. So the package exposes **one** `connect`, and a server upgrading its era
stays invisible to user code. (Contrast `@effect-uai/responses` vs
`@effect-uai/chat-completions`, which are separate packages precisely because
_there_ the protocol is the developer's choice.) The `protocol` pin covers
"I only want stateless" without an import rewrite.

The implementations are still cleanly separated, one layer down. `modern.ts`
and `legacy.ts` each export a `make` returning an `Era`; they never import
each other, and `connect` branches exactly once, at the probe. No era
conditionals thread through the transports, auth, rpc core, or toolkit.

```ts
type Era = {
  readonly version: string
  readonly serverInfo: ServerInfo
  readonly envelope: (method: string, params: unknown) => unknown
  readonly headers: (method: string, params: unknown) => Record<string, string>
  readonly onInbound: (inbound: Inbound) => Effect.Effect<void>
}
```

## Key design decisions

### 0. Own the wire schema (no dependency on `effect/unstable/ai`)

We define our own MCP message schemas in `internal/schema.ts` with core Effect
`Schema`, rather than importing `effect/unstable/ai/McpSchema`. Reasons:

- `effect/unstable/ai` is an unstable, fast-moving module; pinning our wire
  format to it couples the package to an internal surface that can churn under
  us (it is shaped for effect-smol's own MCP _server_, not a client, and
  targets the pre-rewrite spec).
- The subset a tools-only client needs is small and stable per era.
  Hand-writing these as `Schema.Struct`s is a couple hundred lines and leaves
  us free to track the spec at our own pace.

`internal/schema.ts` is the single source of truth for the wire format, both
eras:

- **Shared:** the JSON-RPC envelope, the `Tool` list entry (`name`,
  `description?`, `inputSchema`), `CallToolResult` (`content[]`, `isError?`,
  `structuredContent?`), the `ContentBlock` union, the JSON-RPC error object.
- **Modern (2026-07-28):** the `_meta` keys
  (`io.modelcontextprotocol/protocolVersion`, `.../clientInfo`,
  `.../clientCapabilities`, `.../serverInfo`), the `server/discover` result
  (`supportedVersions`, `capabilities`, `serverInfo`, `instructions`), the
  required `resultType` on results (decoded as optional so a legacy result's
  absent field reads as `"complete"`, which is what the spec mandates
  **[spec]**), the `CacheableResult` `ttlMs` / `cacheScope` fields (required
  on modern list results, absent on legacy, so optional in our decode), the
  `InputRequiredResult` shape (`inputRequests`, and the `inputResponses` a
  full MRTR client would send back), and all three modern error codes:
  `-32020` HeaderMismatch, `-32021` MissingRequiredClientCapability, `-32022`
  UnsupportedProtocolVersion with its `supported` list. All three matter
  beyond reporting: they are the era discriminator (2c) **[spec]**.
- **Legacy (2025-06-18 / 2025-11-25):** `InitializeRequest` /
  `InitializeResult`, the `notifications/initialized` notification, and the
  inbound `ping` request shape.

Nothing MCP-shaped is imported from effect.

### 1. JSON-RPC client: hand-rolled, modeled on `cdp.ts` (spike settled this)

MCP is JSON-RPC 2.0. We spiked whether `effect/unstable/rpc` could be the client
engine (a foreign-server JSON-RPC 2.0 client over our transport, giving us
correlation / streaming for free). **The spike says no; hand-roll it.** See
`experiments/mcp-rpc-spike/` (runnable) and its README for the evidence. The
short version:

effect-rpc's `RpcSerialization.jsonRpc` is a JSON-RPC-_flavored_ encoding of
effect-rpc's _own_ protocol, built for effect-on-both-ends. It emits
`jsonrpc: "2.0"` and a happy-path unary call round-trips, but it does not
interoperate with a spec JSON-RPC 2.0 peer. Four blockers, all observed
empirically:

- **Notifications are impossible** (disqualifying for the legacy era, whose
  handshake needs an id-less `notifications/initialized`; effect-rpc encodes
  an id-less request as `"id":""`). Same for inbound: a server notification
  decodes as a `Request`.
- **Foreign errors become defects.** An MCP `{ error: { code, message } }`
  decodes to an effect `Die`, not a typed failure.
- **Requests are polluted** with non-standard `headers` / `traceId` / `spanId` /
  `sampled` top-level members.
- **A static `RpcGroup` is required.**

So `internal/rpc.ts` is modeled on `providers/browser/src/internal/cdp.ts`, the
proven JSON-RPC-over-transport client already in this repo: id-correlated
pending `Deferred` map, a reader fiber that fails every pending request on
transport close so callers never hang. It exposes a transport- and era-agnostic
`McpConnection`:

```ts
export type McpConnection = {
  readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, McpError>
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void, McpError>
}
```

Era-specific behavior (the `_meta` envelope, the handshake gate, inbound
request handling) layers on top in `internal/era.ts`; the correlation core does
not know which era it is running.

### 2. Eras on the wire

#### 2a. Modern (2026-07-28): the core model

No handshake, no session. Each call is one self-describing request:

- Params carry `_meta["io.modelcontextprotocol/protocolVersion"]` plus
  `clientInfo` / `clientCapabilities` (ours is `{}`; we are a pure tools
  client). Servers identify themselves back in each result's
  `_meta["io.modelcontextprotocol/serverInfo"]` **[spec]**.
- On HTTP, the headers `MCP-Protocol-Version` (which MUST match the `_meta`
  version, else `-32020` HeaderMismatch), `Mcp-Method`, and (for `tools/call`)
  `Mcp-Name` accompany every POST, and the request MUST send
  `Accept: application/json, text/event-stream` **[spec]**. The response is
  `application/json` or a request-scoped `text/event-stream` that ends with
  the JSON-RPC response; the client MUST accept both.
- `server/discover` returns `supportedVersions` / `capabilities` /
  `serverInfo`. Servers MUST implement it; clients MAY call it up front
  **[spec]**. We call it once at `connect` because it doubles as our era
  probe (2c) and fills `serverInfo`.
- Cancellation is closing the request's SSE stream, which is exactly what
  Effect interruption does to the in-flight POST fiber. A broken stream is
  not resumable; the remedy is re-issuing the request with a fresh id (we
  surface `McpTransportClosed` and leave retry to the caller).
- Results carry a required `resultType`. Absent on legacy results, and the
  spec requires clients to read a missing `resultType` as `"complete"`
  **[spec]**, which is exactly what our optional-field decode does. See
  decision 6 for `"input_required"`.
- **No server-initiated requests exist in the modern era.** Servers MUST NOT
  send JSON-RPC requests on a response stream; sampling / elicitation / roots
  are folded into results as MRTR input requests **[spec]**. `ping`,
  `logging/setLevel` and `notifications/roots/list_changed` were removed
  outright. The rpc reader's inbound-request path is therefore legacy-only.
- The core protocol defines **no client-to-server notifications over
  Streamable HTTP** in this revision (`notifications/cancelled` is stdio-only)
  **[spec]**. `notify` is a legacy-era and stdio affordance.
- An unknown method on a modern HTTP server answers `404 Not Found` carrying
  a JSON-RPC `-32601` body; the body is what distinguishes it from a legacy
  HTTP+SSE server's bare `404` **[spec]**. Notification POSTs answer `202`.

#### 2b. Legacy (2025-06-18 / 2025-11-25): the compatibility mode

The concrete deltas legacy mode adds, and nothing more:

1. The `initialize` request / `InitializeResult` / `notifications/initialized`
   handshake at connect; capabilities and `serverInfo` come from
   `InitializeResult`. Requests other than `initialize` wait for the
   handshake gate.
2. On HTTP: capture `Mcp-Session-Id` from the initialize response and echo it
   on every subsequent request; a `404` on a known session means the session
   expired (fail with `McpTransportClosed`; the caller reconnects). Send
   `MCP-Protocol-Version: <negotiated>` after initialize. Best-effort
   `DELETE` on scope close where the server supports it.
3. Inbound server-initiated **requests** can arrive on SSE streams. We answer
   `ping` with an empty result and answer everything else (sampling,
   elicitation, roots) with `-32601` method-not-found. Inbound notifications
   are ignored. This is the one structural addition to the rpc reader loop;
   it is era-gated in `internal/era.ts`.
4. The standalone GET SSE channel and `Last-Event-ID` resumability stay out of
   scope even in legacy mode (only sampling / elicitation need them).

#### 2c. Era detection at `connect`

One probe, cached for the connection's lifetime (a client is bound 1:1 to one
server, so the spec's "cache per server process / origin" degenerates to a
field). The spec specifies the mechanics **per transport**, and they differ in
their fallback trigger, so `era.ts` takes the discriminator as a parameter
from the transport **[spec]**:

**The recognized-modern-error set.** Both transports pivot on the same
question: is this failure a _recognized modern JSON-RPC error_? Those are
`-32022` UnsupportedProtocolVersion, `-32021` MissingRequiredClientCapability,
and `-32020` HeaderMismatch **[spec]**. Any of them proves the server is
modern, so the client corrects and retries rather than falling back. Anything
else (empty body, non-JSON-RPC body, an unrecognized code) means legacy.

**stdio:** send `server/discover`; fall back to `initialize` on any error that
is not a recognized modern error (or on a timeout).

**HTTP:** issue the modern request (`server/discover`). On `400 Bad Request`,
inspect the body before falling back, per the rule above. A `4xx` without a
recognized modern error body means legacy.

Then, in both cases:

1. A `DiscoverResult` means modern; keep the negotiated version.
2. `-32022` means modern but version-mismatched: retry with a mutual version
   from its `supported` list, or fail `McpUnsupportedProtocol` if the
   intersection is empty.
3. Otherwise fall back to the legacy `initialize` handshake. If that
   negotiation lands on a version we do not support (a 2025-03-26-only
   server), fail `McpUnsupportedProtocol` naming the offered version.

We deliberately do **not** implement the spec's further fallback to the
deprecated 2024-11-05 HTTP+SSE transport (GET, `endpoint` event). That
transport is Deprecated under the new feature-lifecycle policy **[spec]**;
those servers get `McpUnsupportedProtocol`.

The config can pin `protocol: "2026-07-28" | "2025-06-18"` to skip detection
(useful for tests and for servers with ambiguous error behavior); the default
is `"auto"`.

### 3. Transport abstraction (both HTTP and stdio in v1, behind one seam)

A `Transport` interface is the seam the JSON-RPC client rides on, so the
correlation core never knows which transport is underneath:

```ts
export type Transport = {
  readonly send: (frame: string) => Effect.Effect<void, McpError>
  readonly messages: Stream.Stream<string, McpError> // framed JSON messages out
}
```

- **Streamable HTTP** (`internal/httpTransport.ts`). POST each client message
  to the single MCP endpoint via `HttpClient`, in a fiber tied to the calling
  request's scope (so interruption aborts the POST: modern cancellation for
  free). The response is either one JSON message (`application/json`) or an
  SSE stream (`text/event-stream`) framed into `messages`; frames from all
  in-flight POSTs demux into the one stream and the rpc layer correlates by
  id. Era-specific headers (modern: `MCP-Protocol-Version` / `Mcp-Method` /
  `Mcp-Name` / `Mcp-Param-*`; legacy: `Mcp-Session-Id`) are supplied per
  request by `internal/era.ts`. Auth headers come from §4. Scoped.

**`x-mcp-header` -> `Mcp-Param-*` is mandatory for clients, not optional
**[spec]**.** This is the one item the pre-verification plan got wrong and it
moves _into_ v1 scope. The spec: "While the use of `x-mcp-header` is optional
for servers, clients **MUST** support this feature." Concretely the HTTP
transport must:

- Read `x-mcp-header` annotations off a tool's `inputSchema` and mirror the
  annotated argument values into `Mcp-Param-{Name}` headers on `tools/call`.
  Only statically-reachable primitive properties (a chain of `properties`
  keys, never through `items` / `$ref` / composition keywords) may carry one.
- Encode values that are not header-safe (non-ASCII, control chars, leading
  or trailing space, or a literal that looks like the sentinel) with the
  Base64 sentinel form `=?base64?<b64>?=`. The same rule applies to `Mcp-Name`.
- **Reject** a tool whose `x-mcp-header` annotations violate the constraints,
  by excluding just that tool from the `tools/list` result and logging a
  warning. One malformed tool must not sink the rest of the toolkit, which
  lands naturally on `Toolkit.fromArray`'s filter step (§6).
- On a `-32020` HeaderMismatch caused by missing or stale `Mcp-Param-*`, the
  spec's remedy is to re-fetch `tools/list` and retry once. v1 surfaces
  `McpProtocolError` instead and leaves the retry to the caller; the seam is
  the same place a later auto-refresh would sit.

stdio transports MAY ignore `x-mcp-header` entirely **[spec]**, so this lives
solely in `httpTransport.ts`.

- **stdio** (`internal/stdioTransport.ts`). Spawn the server via
  `ChildProcess`, write frames to the `stdin` sink, and frame `stdout` with
  `@effect-uai/core/JSONL` (already used by `cdp.ts` for exactly this: one
  JSON message per line). Scoped: the subprocess is killed on scope close
  (`killSignal`, `forceKillAfter`). Config: `{ command, args?, env?, cwd? }`.
  No content negotiation, no auth seam, no session id; era still applies (a
  stdio server can be either era; the same 2c probe runs over stdio).

**SSE framing** (the HTTP transport's one fiddly part): read the
`text/event-stream` body, split on blank-line event boundaries, concatenate
each event's (possibly multi-line) `data:` field, ignore `event:` / `id:` /
comment lines, decode each `data:` payload as one JSON-RPC message. An
`application/json` response is the trivial single-message case. Both eras need
both response shapes (verified live: DeepWiki and Microsoft Learn answer
SSE-framed, Hugging Face answers plain JSON).

### 4. Authentication (static header, pluggable token source, OAuth)

Remote MCP servers gate on auth far more than local ones, and both eras make
the server an OAuth 2.1 resource server. Auth is era-blind and first-class:
one seam with three levels of built-in help so the common cases are turnkey
and the hard case is still reachable:

```ts
export type Auth =
  // 1. A fixed token / header. The turnkey case for a token-gated server.
  | {
      readonly _tag: "Static"
      readonly token: Redacted.Redacted<string>
      readonly scheme?: string /* default "Bearer" */
    }
  // 2. Bring-your-own: an Effect that yields a (possibly refreshed) token per
  //    request. Any external OAuth / secret manager plugs in here with zero
  //    library buy-in. The transport caches and refreshes off this.
  | {
      readonly _tag: "TokenSource"
      readonly token: Effect.Effect<Redacted.Redacted<string>, McpAuthError>
    }
  // 3. Built-in OAuth 2.1. `OAuth.clientCredentials(...)` (fully headless) or
  //    `OAuth.authorizationCode(...)` (needs an app-supplied redirect handler)
  //    both *produce* a TokenSource, so they ride the same seam as (2).
  | { readonly _tag: "OAuth"; readonly source: TokenSource }
```

Design points:

- **The transport applies auth per request** (`Authorization: <scheme> <token>`),
  reading from a cached token with expiry so a `TokenSource` / OAuth refresh
  happens transparently. Tokens are `Redacted` end to end (never logged,
  matches the provider convention for api keys).
- **401 discovery is decoded, not swallowed.** On a `401` with a
  `WWW-Authenticate` header, the transport surfaces a typed `McpAuthRequired`
  carrying the parsed Protected Resource Metadata pointer (RFC 9728,
  `/.well-known/oauth-protected-resource`). Verified live: Linear's server
  returns exactly this shape on an unauthenticated request, so it is our
  conformance target for the error path.
- **What v1 ships:**
  - `Static` and `TokenSource` (levels 1 and 2) fully. Level 2 means _any_
    OAuth story works on day one, because the app owns the token. Verified
    live: Linear accepts a plain API key as `Authorization: Bearer`, so the
    `Static` case covers it with no OAuth dance.
  - `OAuth.clientCredentials`: the full RFC 8414 / RFC 9728 discovery plus the
    OAuth 2.1 client-credentials grant, which is fully automatable with no
    user interaction. Handles token caching + refresh, emits a `TokenSource`.
- **What is deferred (phase 2), with the seam already fitting it:**
  - `OAuth.authorizationCode` (PKCE + interactive consent). The redirect /
    callback capture is inherently an application concern (it needs an HTTP
    route or a desktop loopback listener), so this ships as a helper that takes
    an app-provided "open this URL, give me back the code" callback and does
    client registration + PKCE + code exchange + refresh around it. Designed
    now, built when there is a concrete app to shape the callback.
  - Full client-registration polish and resource-indicator (RFC 8707) edge
    cases.

**Authorization hardening in 2026-07-28 that this seam must respect
**[spec]**.** None of it blocks v1 (`Static` / `TokenSource` /
`clientCredentials` are unaffected), but it retargets the phase-2 helper:

- **RFC 7591 Dynamic Client Registration is now deprecated** in favor of
  **Client ID Metadata Documents**. `OAuth.authorizationCode` should target
  CIMD first and keep DCR only as the compatibility path for authorization
  servers that lack it. The plan's original "RFC 7591 dynamic client
  registration" framing is stale.
- Clients **MUST** validate a present `iss` in the authorization response
  against the recorded issuer before redeeming the code (RFC 9207).
- Client credentials are bound to the issuing authorization server: key
  persisted credentials by issuer identifier, never reuse them against a
  different AS, and re-register when the AS changes.
- DCR requests must specify an appropriate `application_type` to avoid OIDC
  redirect-URI conflicts.

`OAuth` lives in its own export subpath (`@effect-uai/mcp/OAuth`) so the base
client carries no OAuth code weight for users who pass a `Static` token.

### 5. `McpClient` service + `connect` + `layer` (mirror `Browser`)

```ts
// v1: HTTP and stdio, picked by the `transport` discriminant.
export type McpClientConfig =
  | {
      readonly transport: "http"
      readonly url: string
      readonly headers?: Record<string, string>   // static, non-auth headers
      readonly auth?: Auth                          // see §4; omit for a public server
      readonly protocol?: "auto" | "2026-07-28" | "2025-06-18" // default "auto" (§2c)
    }
  | {
      readonly transport: "stdio"
      readonly command: string
      readonly args?: ReadonlyArray<string>
      readonly env?: Record<string, string>        // API keys etc. for the child
      readonly cwd?: string
      readonly protocol?: "auto" | "2026-07-28" | "2025-06-18"
    }

export type McpClient = {
  readonly listTools: Effect.Effect<ReadonlyArray<McpToolInfo>, McpError>
  readonly callTool: (name: string, args: unknown) =>
    Effect.Effect<CallToolResult, McpError>
  readonly serverInfo: ServerInfo   // name/version/capabilities + negotiated era
}

// The primitive: scoped, runs the era probe (§2c), torn down on scope close.
export const connect = (config: McpClientConfig):
  Effect.Effect<McpClient, McpError, Scope.Scope> => ...

// DI convenience for the single-server app (connects on layer build).
export class Mcp extends Context.Service<Mcp, McpClient>()(
  "@betalyra/effect-uai/providers/mcp/Mcp",
) {}
export const layer = (config: McpClientConfig): Layer.Layer<Mcp, McpError> =>
  Layer.effect(Mcp, connect(config))   // scoped layer
```

`connect` resolves `serverInfo` in both eras (modern: from `server/discover`,
which the 2c probe already ran; legacy: from `InitializeResult`), so the
public surface is era-uniform. `serverInfo` also exposes the negotiated
protocol version for observability. `connect` returning a scoped client value
(rather than a `Browser`-style `create` on a service) is the right shape here:
a client is bound 1:1 to one server for its lifetime. `layer` covers the
common "one server, provide it once" case.

### 6. `mcpToolkit(client)`: the payoff

```ts
export const mcpToolkit = (
  client: McpClient,
  options?: { readonly prefix?: string },
): Effect.Effect<Toolkit, McpError>
```

- `yield* client.listTools`, map each `McpToolInfo` to a `LocalTool` via
  `Tool.make`, index with `Toolkit.fromArray` (dynamic names, last-wins).
- If `options.prefix` is set, run through `Toolkit.namespace(prefix, kit)` so a
  server's generic `search` becomes `<prefix>__search` and survives `compose`
  with other toolkits. Recommend a prefix in docs whenever composing multiple
  servers.
- Returns an `Effect` (not a bare value like `browserToolkit`) because the tool
  list is fetched. This composes naturally with `Toolkit.compose` (also
  effectful).

Usage the plan is designed to make trivial:

```ts
// remote server over HTTP (era auto-detected)
const wiki =
  yield *
  connect({
    transport: "http",
    url: "https://mcp.deepwiki.com/mcp",
  })

// local server over stdio
const fs =
  yield *
  connect({
    transport: "stdio",
    command: "pnpx",
    args: ["@modelcontextprotocol/server-filesystem", "/tmp"],
  })

const kit = yield * mcpToolkit(fs, { prefix: "fs" })
// kit drops straight into streamTurn / Toolkit.run alongside your own tools
```

**MCP tool -> `LocalTool` mapping.** Each `McpToolInfo` is
`{ name, description?, inputSchema: JSONSchema }`.

- **Input schema.** MCP hands us a JSON Schema, not a Standard Schema. Build a
  passthrough `ToolInputSchema` exactly like core's `Tool.noInput` does by
  hand: `jsonSchema.input: () => mcpTool.inputSchema` (verbatim, so the model
  sees the server's real schema), `validate: (v) => ({ value: v })` (the
  server is the authoritative validator; do not double-validate a schema we
  did not author). Set `strict: false` (server schemas are not written to
  OpenAI strict rules).
- **`run`.** Closes over the connected `client`, calls
  `client.callTool(name, input)`. Because `client` is a resolved value, the
  tool's `R` is `never`. The tool's `E` is `McpError`.
- **Result -> Output.** On `CallToolResult`:
  - `isError: true` -> `yield* Tool.fail(text, { kind: "tool_failed" })` so the
    executor absorbs it into a model-visible `ToolResult.Failure`. This is the
    designed path for "the tool told the model it went wrong."
  - modern `resultType: "input_required"` (an `InputRequiredResult`: the
    server needs elicitation / sampling / roots input and carries the asks in
    `inputRequests`) -> fail with a typed `McpProtocolError` naming the
    requested input kinds. This is a protocol capability gap, not something
    the model can fix, so it is not a model-visible failure. The phase-2
    completion is well-defined **[spec]**: gather the inputs, then **re-issue
    the original request with a new request id** carrying `inputResponses`
    alongside the original params. There is no server-initiated request and
    no completion notification to wait on, so the seam is a retry loop around
    `callTool`, not a new channel.
  - a result that omits `resultType` (every legacy result) MUST be treated as
    `"complete"` **[spec]**; our optional decode gives that for free.
  - otherwise -> return `structuredContent` when present, else the joined text
    content blocks. Non-text blocks (image/audio/resource) are summarized as a
    short placeholder string in v1 (see deferred scope).
  - a transport/protocol failure (server died, timeout, malformed reply) fails
    with `McpError`, which propagates typed on `Toolkit.run`. A caller who
    wants those visible to the model instead wraps with
    `Toolkit.describeFailures(McpError.describe)`. Ship an `McpError.describe`
    to make that one-liner work (mirrors `BrowserError.describe`).

### 7. Errors (`McpError.ts`)

A small tagged family, `describe`-able:

- `McpConnectFailed` (transport could not establish: DNS / TLS / non-2xx on the
  first request, or a failed handshake / era probe).
- `McpUnsupportedProtocol` (negotiation ended on a version we do not support:
  a 2025-03-26-only server, or a modern server whose `supported` list has no
  mutual version; carries the versions the server offered).
- `McpProtocolError` (bad handshake, JSON-RPC error reply carrying its `code`,
  decode failure, unsupported `input_required`). Carries the modern codes
  (`-32020`, `-32022`) as data when present.
- `McpTransportClosed` (connection dropped with a request in flight; legacy
  session expiry).
- `McpAuthRequired` (a `401` with `WWW-Authenticate`; carries the parsed
  Protected Resource Metadata pointer so an OAuth layer can start discovery).
- `McpAuthError` (a `TokenSource` / OAuth grant failed to mint or refresh a
  token). The `Auth` seam (§4) fails with this.

## File-by-file work

1. `internal/schema.ts`: our own `Schema.Struct`s, both eras (see decision 0).
   Self-contained; nothing MCP-shaped imported from effect.
2. `internal/auth.ts`: the `Auth` -> per-request header resolver, token cache +
   refresh, and `WWW-Authenticate` / RFC 9728 / RFC 8414 discovery parsing.
3. `internal/httpTransport.ts` + `internal/stdioTransport.ts`: the `Transport`
   type and both impls. HTTP on `HttpClient` + SSE framing (scoped),
   per-request fibers so interruption aborts the POST, applying auth from (2);
   stdio on `ChildProcess` + `JSONL` (scoped, kills the child on close).
4. `internal/rpc.ts`: the era-blind correlation core over a `Transport`
   (pending-`Deferred` map, reader fiber, fail-pending-on-close). Hand-rolled,
   modeled on `cdp.ts` (the decision-1 spike ruled out `effect/unstable/rpc`).
5. `internal/era.ts` + `internal/modern.ts` + `internal/legacy.ts`: the `Era`
   interface and the 2c probe in `era.ts`; the modern `_meta` / header
   envelope in `modern.ts`; the legacy handshake gate, session echo and
   inbound-request answering (`ping` -> `{}`, everything else -> `-32601`) in
   `legacy.ts`. The two impls are independent and separately unit-testable.
6. `McpError.ts`: the tagged errors + `describe`.
7. `Client.ts`: `connect` (open transport -> rpc -> era probe -> client
   value), the `Mcp` service tag, `layer`, the `Auth` type.
8. `OAuth.ts`: `OAuth.clientCredentials` (v1) producing a `TokenSource`;
   `OAuth.authorizationCode` stub/typedef for phase 2.
9. `Toolkit.ts`: `mcpToolkit` (list -> map -> `fromArray` -> optional
   `namespace`).
10. `index.ts`: re-exports.
11. `package.json` / `tsconfig.json` / `tsdown.config.ts`: copy from
    `providers/browser`, add the `./OAuth` export subpath, swap
    name/description/keywords, add the package to the changeset fixed group in
    `.changeset/config.json`.

## Sequencing

0. ~~Spike `effect/unstable/rpc`~~ **Done** (decision 1,
   `experiments/mcp-rpc-spike/`): it cannot interoperate with a foreign
   JSON-RPC 2.0 peer, so `internal/rpc.ts` is hand-rolled on the `cdp.ts`
   model.
1. **`internal/schema.ts` + `internal/rpc.ts`**: the wire structs (both eras)
   and the era-blind correlation core. Unit-testable against an in-memory
   `Transport` stub before any network.
2. **Stateless spine over stdio**: `server/discover` + `tools/list` +
   `tools/call`, unit-tested against the in-memory `Transport` stub. The
   stateless era is the core model and the simplest wire flow, so it proves
   the spine first, without waiting on ecosystem servers or standing up a
   fake one.
3. **Legacy mode over stdio against a real server**:
   `pnpx @modelcontextprotocol/server-everything` (the purpose-built client
   exerciser: 20 tools across every content type). Adds the handshake gate
   and inbound `ping` handling.
4. **`httpTransport` + era detection**: both response shapes
   (`application/json` and `text/event-stream`) against a mocked
   `HttpClient`, then live: DeepWiki + Microsoft Learn (legacy, SSE-framed,
   the latter exercising `Mcp-Session-Id`), Hugging Face (legacy, plain
   JSON), `server-everything streamableHttp` on `http://localhost:3001/mcp`.
   GitMCP as the `McpUnsupportedProtocol` negotiation-failure test. For live
   stateless era: the GitHub MCP server (already on 2026-07-28; needs a PAT).
5. **Auth** (HTTP): `Static` + `TokenSource` through the transport; the 401
   discovery path against Linear unauthenticated
   (`https://mcp.linear.app/mcp` returns the RFC 9728 `WWW-Authenticate`
   pointer), then a real call with the Linear API key as a `Static` bearer;
   then `OAuth.clientCredentials` discovery + grant against a token-gated
   server.
6. **`mcpToolkit` + the recipe** driving a real public server through
   `streamTurn`. This is the integration test: no mock server process exists,
   so the recipe is what proves the stdio / HTTP transports against reality.
7. Docs + changeset + skill (below).
8. (Phase 2, separate change) `OAuth.authorizationCode`, behind the §4 seam.

## Testing

- An in-memory `Transport` stub (a scripted `messages` stream + a recording
  `send`) to unit-test `internal/rpc.ts` and `internal/era.ts`: id
  correlation, a JSON-RPC error reply becoming `McpProtocolError`, transport
  close failing every pending request; modern requests carrying the `_meta`
  envelope; the legacy handshake gate; an inbound legacy `ping` answered,
  an inbound sampling request answered `-32601`.
- Era detection against scripted stubs, covering the spec's discriminator
  precisely **[spec]**: a modern `server/discover` reply -> modern; a `-32022`
  with a mutual version -> retry lands on it; `-32022` with a disjoint
  `supported` list -> `McpUnsupportedProtocol`; `-32021` and `-32020` -> still
  modern (correct and retry, never fall back); a `400` with an empty or
  non-JSON-RPC body -> legacy `initialize` fallback; a bare `404` -> legacy,
  while a `404` carrying a `-32601` JSON-RPC body -> modern; a 2025-03-26-only
  negotiation -> `McpUnsupportedProtocol`. Assert the era is probed once and
  cached, not re-probed per request.
- `x-mcp-header` handling (the client MUST, §3): an annotated primitive lands
  on `Mcp-Param-{Name}`; a non-ASCII value and a value matching the sentinel
  pattern are Base64-encoded as `=?base64?...?=`; a `null` or absent argument
  omits the header; an annotation on a property behind `items` / `$ref` /
  `oneOf`, on a `number`, or with a case-insensitively duplicated name causes
  **only that tool** to be dropped from the toolkit while its siblings survive.
  Use the spec's own `execute_sql` / `Mcp-Param-Region` example as a fixture.
- `httpTransport` against a mock `HttpClient` layer (the providers' test
  pattern): a single-JSON response and an SSE-framed response both demux to
  the same `messages`; modern headers (`MCP-Protocol-Version`, `Mcp-Method`,
  `Mcp-Name`) present per request; the legacy `Mcp-Session-Id` from
  `initialize` echoed on later requests; interrupting a call aborts its POST.
- Auth against a mock `HttpClient`: a `Static` token lands on the
  `Authorization` header; a `401` + `WWW-Authenticate` becomes `McpAuthRequired`
  with the parsed metadata pointer; a `TokenSource` is re-read (and cached)
  across requests; `OAuth.clientCredentials` performs the discovery + grant and
  refreshes an expired token.
- **No JavaScript fixtures, and no mock MCP server process.** An earlier draft
  of this plan called for in-repo mock server scripts (one per era) that the
  stdio tests would spawn. Dropped: they are `.js` in a TypeScript repo, and
  standing up a fake server to talk to is an integration test wearing a unit
  test's clothes. Unit tests drive `Protocol` and `rpc` through the in-memory
  `Transport` stub instead, which exercises the same code with none of the
  process management. `stdioTransport`'s own spawn / frame / kill-on-close path
  is covered by the recipe below, which runs a real server.
- Tests use `@effect/vitest` (`it.effect`), the repo standard. Assert behavior
  that can break (era discrimination, the `-32022` retry, header/`_meta`
  agreement, Base64 sentinel encoding), never that a constant is still itself.
- `mcpToolkit` against a mocked client: a successful call serializes to Output,
  an `isError` call surfaces as a `ToolResult.Failure`, an `input_required`
  result fails typed, a transport failure propagates as `McpError` on
  `Toolkit.run`.
- `expectTypeOf` in a real `.test.ts` (no scratch files): a tool from
  `mcpToolkit` has `R = never` and `E = McpError`; `ToolkitR<typeof kit>` is
  `never`.

## Docs / release (additive, minor)

- New docs section. MCP is a tool _source_, not a capability with a swappable
  core tag, so it slots under **Language models > Tools** as an "MCP tools"
  page (overview + both a local stdio and a remote HTTP quickstart + the
  `compose`-with-your-own-tools pattern), plus one recipe ("MCP tools in a
  loop"). State the supported protocol versions (2026-07-28 and 2025-06-18,
  auto-negotiated) and that 2025-03-26 servers are rejected with a typed
  error. Add the sidebar entries in `webpage/astro.config.mjs`.

### The recipe is also the integration test

The "MCP tools in a loop" recipe points at a **public, well-known, keyless MCP
server** and drives it through `streamTurn`, so it doubles as the end-to-end
proof that the transport, the probe, and `mcpToolkit` work against a real
server rather than a stub. It uses the `Stream` pipeline wiring (connection
lifetime = stream lifetime), so nothing has to be drained at the build site:

```ts
Stream.fromEffect(Mcp.connect(config)).pipe(
  Stream.mapEffect(mcpToolkit),
  Stream.flatMap(loopStream),
  Stream.scoped,
)
```

**Preferred target: a stateless (2026-07-28) public server**, since that is the
protocol we lead with. Open problem: as of the 2026-08-28 probe there is no
known public _keyless_ stateless server. GitHub's MCP server is on 2026-07-28
but needs a PAT, and every keyless server (DeepWiki, Microsoft Learn, Hugging
Face, Cloudflare docs) is still handshake-era. So at implementation time:

1. Re-probe for a keyless stateless server and prefer it if one exists.
2. Otherwise ship the recipe against DeepWiki (keyless, legacy) and add a
   second runner pinned to the stateless protocol against GitHub MCP, gated on
   a `GITHUB_TOKEN` in the environment and skipped when unset.

Either way the recipe demonstrates that era negotiation is invisible to the
user's code, which is the whole point of the dual-era design.

- Changeset: additive `minor`. Only the new `@effect-uai/mcp` package (no core
  change). It debuts in the fixed group at the current group version per the
  lockstep policy.
- No migration page (nothing breaks). One line in the next migration guide's
  "What's new" is enough.
- Skill: an additive note in `skills/effect-uai` on wiring MCP tools; no
  migrate-skill entry (no rewrites).

## Risks / open questions

- **The modern spec is one month old** (finalized 2026-07-28) and the
  ecosystem is still overwhelmingly legacy: every public no-auth server we
  probed (2026-08-16) negotiates 2025-06-18. All four Tier 1 SDKs (TypeScript,
  Python, Go, C#) now ship 2026-07-28 support **[spec]**, so the server side
  will move, but the deployed fleet has not yet. Consequences: the legacy path
  gets the real-server soak-testing early, and the stateless path leans on
  scripted stubs plus the GitHub MCP server until adoption catches up.
  Re-probe the test targets at implementation time; the era mix will shift
  under us. This inverts the usual confidence ordering: our primary path is
  the one with the least real-server exposure at ship time, which is why the
  recipe should run against a live stateless server as soon as a public one
  exists.
- **Era-detection robustness.** The 2c fallback keys off the shape of the
  first failure, and legacy servers are not obligated to fail modern requests
  in any particular way (the spec says they "may error arbitrarily").
  The `protocol` pin is the escape hatch; if a popular server misbehaves
  under auto-detection, document the pin for it.
- **Modern header/`_meta` conformance.** `MCP-Protocol-Version` must match the
  `_meta` version or servers reject with `-32020`; keep both minted from one
  constant. ~~The `Mcp-Param-*` mirroring is a gateway routing aid we can
  defer~~ **Resolved 2026-08-28: it is a client MUST**, and is now in v1 scope
  (§3). The residual risk is narrower: the annotation-validity rules are
  fiddly (static reachability, primitive-only, no `number`, case-insensitive
  uniqueness) and a wrong reading silently drops tools, so this needs direct
  unit tests against the spec's own examples rather than a live server.
- **Streamable HTTP SSE framing.** A POST is answered by either a single JSON
  body or a `text/event-stream`, in both eras (verified live both ways:
  DeepWiki/MS Learn SSE-framed, Hugging Face plain JSON). Confirm the SSE
  parser handles multi-`data:` events. The standalone GET channel and
  `Last-Event-ID` are out of scope in both eras.
- **Auth reach.** v1 covers `Static` (verified sufficient for Linear via API
  key as bearer), `TokenSource` (any external OAuth plugs in), and built-in
  `OAuth.clientCredentials` (headless). The gap is `OAuth.authorizationCode`
  (interactive consent + PKCE), deferred because the redirect capture is an
  app concern; the `Auth` seam and the `McpAuthRequired` discovery error are
  built so that follow-up is additive, not a redesign.
- **stdio runtime portability.** `ChildProcess` is effect-smol's own primitive,
  so it should abstract the host, but verify a stdio server spawns and frames
  cleanly under Node, Bun, and Deno before claiming multi-runtime support in
  docs. If a recipe needs a runtime-specific spawn, name its runner files per
  the runtime convention (`run-node.ts` / `run-bun.ts` / `run-deno.ts`).
- **Result content fidelity.** Serializing non-text blocks to placeholders is a
  v1 compromise. Fine for the dominant text/JSON tools; revisit when the loop
  grows a multimodal tool-output path.

## Reference: verified test targets (re-probed live 2026-08-28)

| Target            | Where                                                  | Era                        | Notes                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hugging Face** | `https://huggingface.co/mcp` | **stateless (2026-07-28)** | No auth, plain-JSON responses. Migrated from legacy since the 2026-08-16 probe. The recipe's default target. **Verified end to end 2026-08-28.** |
| DeepWiki          | `https://mcp.deepwiki.com/mcp`                         | legacy (2025-06-18)        | no auth; SSE-framed. Rejects a stateless request with HTTP 400 + `-32600`, _not_ `-32022` (see below)                                                                             | **Verified end to end 2026-08-28.**
| Microsoft Learn   | `https://learn.microsoft.com/api/mcp`                  | legacy (2025-06-18)        | no auth; stateful `Mcp-Session-Id`; answers `server/discover` with HTTP **200** + `-32601`                                                                                        | **Verified end to end 2026-08-28.**
| Cloudflare docs   | `https://docs.mcp.cloudflare.com/mcp`                  | legacy (2025-06-18)        | no auth; secondary                                                                                                                                                                |
| server-everything | `pnpx @modelcontextprotocol/server-everything` (stdio) | legacy                     | 20 tools, every content type; the purpose-built client exerciser                                                                                                                  |
| GitMCP            | `https://gitmcp.io/{owner}/{repo}`                     | 2025-03-26                 | the `McpUnsupportedProtocol` negotiation-failure test                                                                                                                             |
| GitHub MCP        | `https://api.githubcopilot.com/mcp/`                   | stateless (2026-07-28)     | needs a PAT                                                                                                                                                                       |
| **Linear** | `https://mcp.linear.app/mcp` | **stateless (2026-07-28)** | **Also migrated; this plan previously recorded it as handshake-era.** Accepts a Linear API key as a `Static` bearer (57 tools). Unauthenticated it returns 401 + the RFC 9728 `resource_metadata` pointer. The authenticated stateless target. **Verified end to end 2026-08-28.** |

### What the end-to-end runs proved (2026-08-28)

Four servers driven through the full recipe (transport -> rpc -> probe ->
toolkit -> agent loop), covering both eras and both auth states:

- **Era detection works in both directions.** Hugging Face and Linear negotiate
  the stateless protocol; DeepWiki and Microsoft Learn fall through the
  stateless probe and land on `initialize`. User code is identical in all four.
- **`serverInfo` resolves from both eras**: `_meta` on stateless, the
  `InitializeResult` body on handshake.
- **The `isError` -> `Tool.fail` path validated itself unprompted.** Linear
  rejected a bad `fields` argument; that surfaced as a model-visible
  `ToolResult.Failure` rather than a typed `McpError` ending the run, and the
  model dropped the offending field and retried successfully. This is the
  designed failure model working against a real server.
- **Auth works** via `Auth.Static` with a Linear API key as a bearer.

Four bugs were found only by running it, each now covered by a regression test:
`bodyText` overriding the JSON content type with `text/plain`; a silent hang on
an `id: null` error reply; a silent hang on an error under an id we never
issued (DeepWiki answers `"id":"server-error"`); and `serverInfo` being read
from the top level instead of `_meta`. Every one of them was invisible to unit
tests written against a stub that behaved the way I assumed servers behave.

### What the live probe proved about era detection

Two real legacy servers reject a stateless request in two _different_ non-spec
ways, which is exactly the robustness risk this plan flagged. Neither returns a
recognized modern error code, so both correctly fall through to the handshake
under our discriminator:

- **DeepWiki**: `HTTP 400` with `-32600` (Invalid Request), and the human-readable
  message carries the supported list instead of the `data.supported` field a
  `-32022` would use. Falling back on "not a recognized modern code" is what
  saves us; keying off the HTTP status alone would misread this.
- **Microsoft Learn**: `HTTP 200` with `-32601` (Method not found). A status-based
  discriminator would call this success. Keying off the JSON-RPC error code in
  the body is load-bearing.

This validates decision 2c: the discriminator must be the error **code**
(`-32020` / `-32021` / `-32022`), never the HTTP status.
