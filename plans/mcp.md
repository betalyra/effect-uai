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

The spec split into two eras with the **2026-07-28** revision (finalized
2026-07-28; the "stateless rewrite," SEP-2575/SEP-2567). Everything before it
(2025-06-18, 2025-11-25) is the handshake era. The spec's own compatibility
matrix is blunt: a modern-only client against a legacy server **fails**, with
no graceful degradation.

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
- Sampling and elicitation. Legacy servers request these as server-initiated
  JSON-RPC requests (we answer with method-not-found, decision 2b); modern
  servers request them as Multi Round-Trip Requests, a result with
  `resultType: "input_required"` (we fail typed, decision 6). Same posture in
  both eras: v1 is a headless tools client.
- The modern `subscriptions/listen` channel and the `io.modelcontextprotocol/tasks`
  extension (long-running operations). Not needed for request/response tools.
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
      era.ts            # era detection + the era-specific request envelope/handshake glue
      httpTransport.ts  # Streamable HTTP Transport impl (applies Auth; SSE framing; era headers)
      stdioTransport.ts # stdio Transport impl (ChildProcess + JSONL framing)
      auth.ts           # token cache/refresh, WWW-Authenticate + RFC 9728/8414 discovery
      schema.ts         # our own MCP wire schemas (Effect Schema), both eras, self-contained
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
  required `resultType` on results, list-result `ttlMs` / `cacheScope`, and
  the modern error codes (`-32020` HeaderMismatch, `-32022`
  UnsupportedProtocolVersionError with its `supported` list).
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
  client).
- On HTTP, the headers `MCP-Protocol-Version` (which MUST match the `_meta`
  version, else `-32020` HeaderMismatch), `Mcp-Method`, and (for `tools/call`)
  `Mcp-Name` accompany every POST. The response is `application/json` or a
  request-scoped `text/event-stream` that ends with the JSON-RPC response;
  the client MUST accept both.
- `server/discover` returns `supportedVersions` / `capabilities` /
  `serverInfo`. Calling it is optional per spec; we call it once at `connect`
  because it doubles as our era probe (2c) and fills `serverInfo`.
- Cancellation is closing the request's SSE stream, which is exactly what
  Effect interruption does to the in-flight POST fiber. A broken stream is
  not resumable; the remedy is re-issuing the request with a fresh id (we
  surface `McpTransportClosed` and leave retry to the caller).
- Results carry a required `resultType`; see decision 6 for
  `"input_required"`.

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

Deterministic, one probe, cached for the connection's lifetime (a client is
bound 1:1 to one server, so "cache per origin" degenerates to a field):

1. Attempt a modern `server/discover` (with the modern headers / `_meta`).
2. Success: modern era. If the reply is `-32022`
   UnsupportedProtocolVersionError, the server is modern but wants another
   version: retry with a mutual version from its `supported` list, or fail
   `McpUnsupportedProtocol` if there is none.
3. Any other failure shape (HTTP 4xx with a non-modern body, JSON-RPC
   method-not-found, a server that answers nonsense): fall back to the legacy
   `initialize` handshake. If that negotiation lands on a version we do not
   support (a 2025-03-26-only server), fail `McpUnsupportedProtocol` naming
   the offered version.

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
  `Mcp-Name`; legacy: `Mcp-Session-Id`) are supplied per request by
  `internal/era.ts`. Auth headers come from §4. Scoped.
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
    the RFC 7591 dynamic client registration + PKCE + code exchange + refresh
    around it. Designed now, built when there is a concrete app to shape the
    callback.
  - Full automated dynamic client registration polish and resource-indicator
    (RFC 8707) edge cases.

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
  - modern `resultType: "input_required"` (the server wants elicitation /
    sampling via a Multi Round-Trip Request) -> fail with a typed
    `McpProtocolError` saying elicitation is unsupported in v1. This is a
    protocol capability gap, not something the model can fix, so it is not a
    model-visible failure.
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
5. `internal/era.ts`: the 2c probe, the modern `_meta` / header envelope, the
   legacy handshake gate + session echo + inbound-request answering (`ping`
   -> `{}`, everything else -> `-32601`).
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
2. **Modern spine over stdio + an in-repo mock server**: `server/discover` +
   `tools/list` + `tools/call` against a tiny Node script speaking 2026-07-28
   on stdin/stdout. The modern era is the core model and the simplest wire
   flow, so it proves the spine first, without waiting on ecosystem servers.
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
   modern era: the GitHub MCP server (already on 2026-07-28; needs a PAT) or
   the in-repo mock over HTTP.
5. **Auth** (HTTP): `Static` + `TokenSource` through the transport; the 401
   discovery path against Linear unauthenticated
   (`https://mcp.linear.app/mcp` returns the RFC 9728 `WWW-Authenticate`
   pointer), then a real call with the Linear API key as a `Static` bearer;
   then `OAuth.clientCredentials` discovery + grant against a token-gated
   server.
6. **`mcpToolkit` + a recipe** driving a real server through `streamTurn`.
7. Docs + changeset + skill (below).
8. (Phase 2, separate change) `OAuth.authorizationCode`, behind the §4 seam.

## Testing

- An in-memory `Transport` stub (a scripted `messages` stream + a recording
  `send`) to unit-test `internal/rpc.ts` and `internal/era.ts`: id
  correlation, a JSON-RPC error reply becoming `McpProtocolError`, transport
  close failing every pending request; modern requests carrying the `_meta`
  envelope; the legacy handshake gate; an inbound legacy `ping` answered,
  an inbound sampling request answered `-32601`.
- Era detection against scripted stubs: a modern `server/discover` reply ->
  modern; a `-32022` with a mutual version -> retry lands on it; a
  method-not-found -> legacy `initialize` fallback; a 2025-03-26-only
  negotiation -> `McpUnsupportedProtocol`.
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
- `stdioTransport` against tiny in-repo mock server scripts (one per era,
  answering on stdin/stdout): the child is spawned, framed, and killed on
  scope close. Needs no network, no installed server.
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
- Changeset: additive `minor`. Only the new `@effect-uai/mcp` package (no core
  change). It debuts in the fixed group at the current group version per the
  lockstep policy.
- No migration page (nothing breaks). One line in the next migration guide's
  "What's new" is enough.
- Skill: an additive note in `skills/effect-uai` on wiring MCP tools; no
  migrate-skill entry (no rewrites).

## Risks / open questions

- **The modern spec is three weeks old** (finalized 2026-07-28) and the
  ecosystem is still overwhelmingly legacy: every public no-auth server we
  probed (2026-08-16) negotiates 2025-06-18, and the reference servers ship
  on the beta TS SDK. Consequences: the legacy path gets the real-server
  soak-testing early, and the modern path leans on the in-repo mock plus the
  GitHub MCP server until adoption catches up. Re-probe the test targets at
  implementation time; the era mix will shift under us.
- **Era-detection robustness.** The 2c fallback keys off the shape of the
  first failure, and legacy servers are not obligated to fail modern requests
  in any particular way (the spec says they "may error arbitrarily").
  The `protocol` pin is the escape hatch; if a popular server misbehaves
  under auto-detection, document the pin for it.
- **Modern header/`_meta` conformance.** `MCP-Protocol-Version` must match the
  `_meta` version or servers reject with `-32020`; keep both minted from one
  constant. The spec also describes mirroring designated params into
  `Mcp-Param-*` headers via an `x-mcp-header` schema annotation (a gateway
  routing aid); verify at implementation time whether any real server
  requires it from clients, and defer it if none does.
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

## Reference: verified test targets (probed 2026-08-16)

| Target | Where | Era | Notes |
|---|---|---|---|
| in-repo mock scripts | `packages/providers/mcp/test/` | both | one per era; stdio + HTTP |
| server-everything | `pnpx @modelcontextprotocol/server-everything` (stdio) / `... streamableHttp` -> `http://localhost:3001/mcp` | legacy | 20 tools, every content type; the purpose-built client exerciser |
| DeepWiki | `https://mcp.deepwiki.com/mcp` | legacy (2025-06-18) | no auth; SSE-framed; tolerates sessionless requests; primary remote target |
| Microsoft Learn | `https://learn.microsoft.com/api/mcp` | legacy (2025-06-18) | no auth; stateful `Mcp-Session-Id`; strict about the dual `Accept` header |
| Hugging Face | `https://huggingface.co/mcp` | legacy (2025-06-18) | no auth (rate-limited); plain-JSON responses (covers the non-SSE shape) |
| Cloudflare docs | `https://docs.mcp.cloudflare.com/mcp` | legacy (2025-06-18) | no auth; secondary |
| GitMCP | `https://gitmcp.io/{owner}/{repo}` | 2025-03-26 | the `McpUnsupportedProtocol` negotiation-failure test |
| GitHub MCP | `https://api.githubcopilot.com/mcp/` | modern (2026-07-28) | needs a PAT; earliest live modern server |
| Linear | `https://mcp.linear.app/mcp` | legacy (handshake) | 401 + RFC 9728 discovery when unauthenticated (the `McpAuthRequired` test); accepts a Linear API key as `Static` bearer |
