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

## What effect-smol already gives us

Confirmed present in `effect@4.0.0-beta.57`:

- `effect/unstable/ai/McpSchema` exists (MCP wire schemas: `ContentBlock`,
  `McpError`, the request / result encodings, the JSON-RPC error codes) and
  effect-smol even ships an MCP _server_ in `McpServer`, but there is no MCP
  _client_, which is the gap we fill. We deliberately **do not depend on**
  `McpSchema`: it is an unstable surface shaped for the server, and we own our
  wire schema instead (see design decision 0). It is listed here only to show
  the client is genuinely missing.
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
MCP protocol version. (MCP's own versions are date-stamped; we target the
`2025-06-18` revision, negotiated at `initialize`, and stay tolerant of the
server negotiating another. Verify the latest revision at modelcontextprotocol.io
before pinning, since the spec moves fast.)

Both transports are in our v1: **Streamable HTTP** (remote servers) and
**stdio** (local subprocess servers). HTTP was the original driver and carries
the auth surface; stdio unlocks the dense local-server ecosystem (filesystem,
git, sqlite, and most community servers). They share the JSON-RPC client and the
toolkit layer via the `Transport` seam (§2), so the second transport is mostly a
second `internal/transport.ts` implementation.

**v1 (this plan):**

- Connect to an MCP server over **Streamable HTTP** or **stdio**.
- The `initialize` handshake, `tools/list`, `tools/call`.
- Build a `Toolkit` from the server's advertised tools, one `LocalTool` per MCP
  tool, each calling `tools/call` over the connection.
- Authentication as a first-class seam (§3) on the HTTP transport: a `Static`
  token, a bring-your-own `TokenSource` (any external OAuth plugs in), and
  built-in `OAuth.clientCredentials` (the fully headless OAuth 2.1 grant, with
  RFC 9728 / RFC 8414 discovery). A `401` surfaces a typed `McpAuthRequired`
  carrying the discovery pointer. (stdio servers authenticate via their spawn
  environment, e.g. an API-key `env` var, not this seam.)

**Deferred (note in docs, do not build yet):**

- Resources (`resources/list` / `resources/read`) and prompts
  (`prompts/list` / `prompts/get`). These map to context injection and message
  templates, not the agent-loop tool surface, so they are phase 2.
- `notifications/tools/list_changed` live refresh. v1 snapshots the tool list at
  `toolkit()` time. The `unknown_tool` path already degrades gracefully if a
  tool vanishes mid-run.
- Sampling (server-initiated LLM calls back through the client) and elicitation.
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
    McpError.ts         # public tagged errors (transport / protocol / init / auth)
    internal/
      rpc.ts            # JSON-RPC 2.0 client over a Transport (hand-rolled, cdp.ts model)
      httpTransport.ts  # Streamable HTTP Transport impl (applies Auth; SSE framing)
      stdioTransport.ts # stdio Transport impl (ChildProcess + JSONL framing)
      auth.ts           # token cache/refresh, WWW-Authenticate + RFC 9728/8414 discovery
      schema.ts         # our own MCP wire schemas (Effect Schema), self-contained
```

## Key design decisions

### 0. Own the wire schema (no dependency on `effect/unstable/ai`)

We define our own MCP message schemas in `internal/schema.ts` with core Effect
`Schema`, rather than importing `effect/unstable/ai/McpSchema`. Reasons:

- `effect/unstable/ai` is an unstable, fast-moving module; pinning our wire
  format to it couples the package to an internal surface that can churn under
  us (and it is shaped for effect-smol's own MCP _server_, not a client).
- The subset a tools-only client needs is small and stable in the MCP spec:
  the JSON-RPC envelope, `InitializeRequest` / `InitializeResult`, `Tool`
  (list entry: `name`, `description?`, `inputSchema`), `CallToolResult`
  (`content[]`, `isError?`, `structuredContent?`), the `ContentBlock` union,
  and the JSON-RPC error object with its standard `code`s. Hand-writing these
  as `Schema.Struct`s is a couple hundred lines and leaves us free to track the
  spec at our own pace.

`internal/schema.ts` is therefore the single source of truth for the wire
format: request/response envelopes, the method-name constants, the result
shapes above, and our own error-code constants (`-32700` parse error, `-32602`
invalid params, ...). Nothing MCP-shaped is imported from effect.

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

- **Notifications are impossible** (disqualifying alone). MCP's handshake needs
  the client to send `notifications/initialized` with no `id`; effect-rpc
  encodes an id-less request as `"id":""`, a malformed request the server tries
  to answer. Same for inbound: a server notification decodes as a `Request`.
- **Foreign errors become defects.** An MCP `{ error: { code, message } }`
  decodes to an effect `Die`, not a typed failure (it expects its own
  `{ error: { _tag: "Cause" } }`).
- **Requests are polluted** with non-standard `headers` / `traceId` / `spanId` /
  `sampled` top-level members.
- **A static `RpcGroup` is required.** MCP's fixed methods fit, but combined with
  the above it is not worth it.

What _did_ work (and is worth borrowing conceptually, not as a dependency): the
request core is clean `{ jsonrpc, method, params, id }`, success responses decode
cleanly, and a unary call emits exactly one `Request` with no control-frame
chatter. But making effect-rpc interoperate means suppressing its control
frames, re-mapping defects, faking id-less notifications, and stripping extra
members: fighting the framework at every seam.

So `internal/rpc.ts` is modeled on `providers/browser/src/internal/cdp.ts`, the
proven JSON-RPC-over-transport client already in this repo: id-correlated
pending `Deferred` map, notification demux into a `PubSub`, a reader fiber that
fails every pending request on transport close so callers never hang. MCP
specifics on top:

- Frame shape is JSON-RPC (`{ jsonrpc: "2.0", id, method, params }`); decode
  replies / errors / notifications with our own `internal/schema.ts` structs. We
  get proper id-less notifications and typed errors precisely because we own the
  codec.
- The `initialize` gate: requests other than `initialize` wait for the
  handshake, and `notifications/initialized` is sent right after.

It lives behind the `McpConnection` interface so nothing else in the package
sees the transport or the codec.

`internal/rpc.ts` exposes a transport-agnostic `McpConnection`:

```ts
export type McpConnection = {
  readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, McpError>
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void, McpError>
  readonly notifications: Effect.Effect<PubSub.Subscription<Notification>, never, Scope.Scope>
}
```

### 2. Transport abstraction (both HTTP and stdio in v1, behind one seam)

A `Transport` interface is the seam the JSON-RPC client rides on, so the client
and toolkit layers never know which transport is underneath:

```ts
export type Transport = {
  readonly send: (frame: string) => Effect.Effect<void, McpError>
  readonly messages: Stream.Stream<string, McpError> // framed JSON messages out
}
```

Both v1 transports satisfy it; `connect` picks by the config discriminant and
the rest of the package is transport-blind.

- **Streamable HTTP** (`internal/httpTransport.ts`). POST each client message to
  the single MCP endpoint via `HttpClient`; the response is either one JSON
  message (`application/json`) or an SSE stream (`text/event-stream`) the
  transport frames into `messages` (see "SSE framing" below). Carries the
  `Mcp-Session-Id` header the server assigns at `initialize` on every subsequent
  request, plus auth headers from §3. Scoped: releases the session on scope
  close (best-effort `DELETE` where the server supports it).
- **stdio** (`internal/stdioTransport.ts`). Spawn the server via `ChildProcess`,
  write frames to the `stdin` sink, and frame `stdout` with
  `@effect-uai/core/JSONL` (already used by `cdp.ts` for exactly this: one JSON
  message per line). Scoped: the subprocess is killed on scope close
  (`killSignal`, `forceKillAfter`). Config: `{ command, args?, env?, cwd? }`.
  Simpler than HTTP (no content negotiation, no auth seam, no session id).

**SSE framing** (the HTTP transport's one fiddly part): a POST can be answered
with a _stream_ of events, not a single reply. The transport reads the
`text/event-stream` body, splits it on blank-line event boundaries, concatenates
each event's (possibly multi-line) `data:` field, ignores `event:` / `id:` /
comment lines, and decodes each `data:` payload as one JSON-RPC message into
`messages`. A `application/json` response is the trivial single-message case.
The optional standalone server->client SSE channel (a long-lived `GET`) and
`Last-Event-ID` resumption are only needed for sampling / elicitation, which are
out of scope, so v1 frames the response body of each POST and nothing more.

The transport is `Effect<Transport, McpError, Scope.Scope>`; `connect` builds
the one named by the config discriminant (§4).

### 3. Authentication (static header, pluggable token source, OAuth)

Remote MCP servers gate on auth far more than local ones, and the modern spec
(MCP 2025-06-18) makes the server an OAuth 2.1 resource server. Auth is
therefore first-class here, designed as one seam with three levels of built-in
help so the common cases are turnkey and the hard case is still reachable:

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
  happens transparently. Tokens are `Redacted` end to end (never logged, matches
  the provider convention for api keys).
- **401 discovery is decoded, not swallowed.** On a `401` with a
  `WWW-Authenticate` header, the transport surfaces a typed `McpAuthRequired`
  carrying the parsed Protected Resource Metadata pointer (RFC 9728,
  `/.well-known/oauth-protected-resource`). Without an OAuth layer this is a
  clear "you need auth, here is the authorization server" error; with one it is
  the discovery input.
- **What v1 ships:**
  - `Static` and `TokenSource` (levels 1 and 2) fully. Level 2 means _any_
    OAuth story works on day one, because the app owns the token.
  - `OAuth.clientCredentials`: the full RFC 8414 / RFC 9728 discovery plus the
    OAuth 2.1 client-credentials grant, which is fully automatable with no user
    interaction. This is the headless server-to-server path and the one we can
    own completely. Handles token caching + refresh, emits a `TokenSource`.
- **What is deferred (phase 2), with the seam already fitting it:**
  - `OAuth.authorizationCode` (PKCE + interactive consent). The redirect /
    callback capture is inherently an application concern (it needs an HTTP
    route or a desktop loopback listener), so this ships as a helper that takes
    an app-provided "open this URL, give me back the code" callback and does the
    RFC 7591 dynamic client registration + PKCE + code exchange + refresh around
    it. Designed now, built when there is a concrete app to shape the callback.
  - Full automated dynamic client registration polish and resource-indicator
    (RFC 8707) edge cases.

`OAuth` lives in its own export subpath (`@effect-uai/mcp/OAuth`) so the base
client carries no OAuth code weight for users who pass a `Static` token.

### 4. `McpClient` service + `connect` + `layer` (mirror `Browser`)

```ts
// v1: HTTP and stdio, picked by the `transport` discriminant.
export type McpClientConfig =
  | {
      readonly transport: "http"
      readonly url: string
      readonly headers?: Record<string, string>   // static, non-auth headers
      readonly auth?: Auth                          // see §3; omit for a public server
    }
  | {
      readonly transport: "stdio"
      readonly command: string
      readonly args?: ReadonlyArray<string>
      readonly env?: Record<string, string>        // API keys etc. for the child
      readonly cwd?: string
    }

export type McpClient = {
  readonly listTools: Effect.Effect<ReadonlyArray<McpToolInfo>, McpError>
  readonly callTool: (name: string, args: unknown) =>
    Effect.Effect<CallToolResult, McpError>
  readonly serverInfo: ServerInfo   // name/version/capabilities from initialize
}

// The primitive: scoped, runs initialize, torn down on scope close.
export const connect = (config: McpClientConfig):
  Effect.Effect<McpClient, McpError, Scope.Scope> => ...

// DI convenience for the single-server app (connects on layer build).
export class Mcp extends Context.Service<Mcp, McpClient>()(
  "@betalyra/effect-uai/providers/mcp/Mcp",
) {}
export const layer = (config: McpClientConfig): Layer.Layer<Mcp, McpError> =>
  Layer.effect(Mcp, connect(config))   // scoped layer
```

`connect` returning a scoped client value (rather than a `Browser`-style
`create` on a service) is the right shape here: a client is bound 1:1 to one
server for its lifetime, so there is no `create`/`attach`/`list` control plane
to model. `layer` covers the common "one server, provide it once" case.

### 5. `mcpToolkit(client)`: the payoff

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
// remote server over HTTP
const gh =
  yield *
  connect({
    transport: "http",
    url: "https://api.githubcopilot.com/mcp/",
    auth: { _tag: "Static", token: Redacted.make(process.env.GITHUB_MCP_TOKEN!) },
  })

// local server over stdio
const fs =
  yield *
  connect({
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  })

const kit = yield * mcpToolkit(fs, { prefix: "fs" })
// kit drops straight into streamTurn / Toolkit.run alongside your own tools
```

### 6. MCP tool -> `LocalTool` mapping

Each `McpToolInfo` is `{ name, description?, inputSchema: JSONSchema }`.

- **Input schema.** MCP hands us a JSON Schema, not a Standard Schema. Build a
  passthrough `ToolInputSchema` exactly like core's `Tool.noInput` does by hand:
  `jsonSchema.input: () => mcpTool.inputSchema` (verbatim, so the model sees the
  server's real schema), `validate: (v) => ({ value: v })` (the server is the
  authoritative validator; do not double-validate a schema we did not author).
  Set `strict: false` (server schemas are not written to OpenAI strict rules).
- **`run`.** Closes over the connected `client`, calls
  `client.callTool(name, input)`. Because `client` is a resolved value, the
  tool's `R` is `never`. The tool's `E` is `McpError`.
- **Result -> Output.** On `CallToolResult`:
  - `isError: true` -> `yield* Tool.fail(text, { kind: "tool_failed" })` so the
    executor absorbs it into a model-visible `ToolResult.Failure`. This is the
    designed path for "the tool told the model it went wrong."
  - otherwise -> return `structuredContent` when present, else the joined text
    content blocks. Non-text blocks (image/audio/resource) are summarized as a
    short placeholder string in v1 (see deferred scope).
  - a transport/protocol failure (server died, timeout, malformed reply) fails
    with `McpError`, which propagates typed on `Toolkit.run`. A caller who wants
    those visible to the model instead wraps with
    `Toolkit.describeFailures(McpError.describe)`. Ship an `McpError.describe`
    to make that one-liner work (mirrors `BrowserError.describe`).

### 7. Errors (`McpError.ts`)

A small tagged family, `describe`-able:

- `McpConnectFailed` (transport could not establish: DNS / TLS / non-2xx on the
  first request, or a failed `initialize`).
- `McpProtocolError` (bad handshake, JSON-RPC error reply carrying our own
  `code` constant, decode failure).
- `McpTransportClosed` (connection dropped with a request in flight).
- `McpAuthRequired` (a `401` with `WWW-Authenticate`; carries the parsed
  Protected Resource Metadata pointer so an OAuth layer can start discovery).
- `McpAuthError` (a `TokenSource` / OAuth grant failed to mint or refresh a
  token). The `Auth` seam (§3) fails with this.

The wire error object (`{ code, message, data? }`) is decoded with our own
`internal/schema.ts` struct; `McpProtocolError` carries its `code`. The public
tagged errors above are the effect-uai-facing surface.

## File-by-file work

1. `internal/schema.ts`: our own `Schema.Struct`s for the JSON-RPC envelope,
   `InitializeRequest` / `InitializeResult`, the `Tool` list entry,
   `CallToolResult`, the `ContentBlock` union, and the error object + code
   constants. Self-contained; nothing MCP-shaped imported from effect.
2. `internal/auth.ts`: the `Auth` -> per-request header resolver, token cache +
   refresh, and `WWW-Authenticate` / RFC 9728 / RFC 8414 discovery parsing.
3. `internal/httpTransport.ts` + `internal/stdioTransport.ts`: the `Transport`
   type and both impls. HTTP on `HttpClient` + SSE framing (scoped), applying
   auth from (2); stdio on `ChildProcess` + `JSONL` (scoped, kills the child on
   close).
4. `internal/rpc.ts`: `McpConnection` over a `Transport` (pending-`Deferred`
   map, notification `PubSub`, reader fiber, fail-pending-on-close). Hand-rolled,
   modeled on `cdp.ts` (the §1 spike ruled out `effect/unstable/rpc`).
5. `McpError.ts`: the tagged errors + `describe`.
6. `Client.ts`: `connect` (open transport -> rpc -> `initialize` -> client
   value), the `Mcp` service tag, `layer`, the `Auth` type.
7. `OAuth.ts`: `OAuth.clientCredentials` (v1) producing a `TokenSource`;
   `OAuth.authorizationCode` stub/typedef for phase 2.
8. `Toolkit.ts`: `mcpToolkit` (list -> map -> `fromArray` -> optional
   `namespace`).
9. `index.ts`: re-exports.
10. `package.json` / `tsconfig.json` / `tsdown.config.ts`: copy from
    `providers/browser`, add the `./OAuth` export subpath, swap
    name/description/keywords, add the package to the changeset fixed group in
    `.changeset/config.json`.

## Sequencing

0. ~~Spike `effect/unstable/rpc`~~ **Done** (§1, `experiments/mcp-rpc-spike/`):
   it cannot interoperate with a foreign JSON-RPC 2.0 peer, so `internal/rpc.ts`
   is hand-rolled on the `cdp.ts` model.
1. **`internal/schema.ts` + `internal/rpc.ts`**: the wire structs and the
   transport-agnostic JSON-RPC client. Unit-testable against an in-memory
   `Transport` stub before any network.
2. **`stdioTransport` + `connect` end to end**: `initialize` + `tools/list` +
   `tools/call` against a real local server (`@modelcontextprotocol/server-everything`
   or `-filesystem`). stdio is the simpler transport (newline-delimited JSON, no
   auth, no content negotiation), so it proves the spine fastest.
3. **`httpTransport`**: the same three calls against a mocked `HttpClient` (both
   the `application/json` and `text/event-stream` response shapes), then one
   real public remote server. Adds SSE framing and the session-id header.
4. **Auth** (HTTP): `Static` + `TokenSource` through the transport; then
   `OAuth.clientCredentials` discovery + grant against a token-gated server.
5. **`mcpToolkit` + a recipe** driving a real server through `streamTurn`.
6. Docs + changeset + skill (below).
7. (Phase 2, separate change) `OAuth.authorizationCode`, behind the §3 seam.

## Testing

- An in-memory `Transport` stub (a scripted `messages` stream + a recording
  `send`) to unit-test `internal/rpc.ts`: handshake gating, id correlation, a
  JSON-RPC error reply becoming `McpProtocolError`, transport close failing
  every pending request.
- `httpTransport` against a mock `HttpClient` layer (the providers' test
  pattern): a single-JSON response and an SSE-framed response both demux to the
  same `messages`, and the `Mcp-Session-Id` from `initialize` is echoed on
  later requests.
- Auth against a mock `HttpClient`: a `Static` token lands on the
  `Authorization` header; a `401` + `WWW-Authenticate` becomes `McpAuthRequired`
  with the parsed metadata pointer; a `TokenSource` is re-read (and cached)
  across requests; `OAuth.clientCredentials` performs the discovery + grant and
  refreshes an expired token.
- `stdioTransport` against a tiny in-repo mock server script (a Node file that
  answers `initialize` / `tools/list` / `tools/call` on stdin/stdout): the child
  is spawned, framed, and killed on scope close. Needs no network, no installed
  server.
- `mcpToolkit` against a mocked client: a successful call serializes to Output,
  an `isError` call surfaces as a `ToolResult.Failure`, a transport failure
  propagates as `McpError` on `Toolkit.run`.
- `expectTypeOf` in a real `.test.ts` (no scratch files): a tool from
  `mcpToolkit` has `R = never` and `E = McpError`; `ToolkitR<typeof kit>` is
  `never`.

## Docs / release (additive, minor)

- New docs section. MCP is a tool _source_, not a capability with a swappable
  core tag, so it slots under **Language models > Tools** as an "MCP tools"
  page (overview + both a local stdio and a remote HTTP quickstart + the
  `compose`-with-your-own-tools pattern), plus one recipe ("MCP tools in a
  loop"). Add the sidebar entries in `webpage/astro.config.mjs`.
- Changeset: additive `minor`. Only the new `@effect-uai/mcp` package (no core
  change). It debuts in the fixed group at the current group version per the
  lockstep policy.
- No migration page (nothing breaks). One line in the next migration guide's
  "What's new" is enough.
- Skill: an additive note in `skills/effect-uai` on wiring MCP tools; no
  migrate-skill entry (no rewrites).

## Risks / open questions

- **Streamable HTTP SSE framing (the main HTTP-transport risk).** Detailed in
  §2: a POST is answered by either a single JSON body or a `text/event-stream`,
  so the transport must frame both. The standalone server->client `GET` SSE
  channel and `Last-Event-ID` resumption stay out of scope (only sampling /
  elicitation need them). Confirm the two or three target servers work
  request/response only, and that our SSE parser handles multi-`data:` events
  and the `Mcp-Session-Id` assignment. stdio has no equivalent risk (plain
  newline-delimited JSON).
- **Auth reach.** v1 covers `Static`, `TokenSource` (any external OAuth plugs
  in), and built-in `OAuth.clientCredentials` (headless). The gap is
  `OAuth.authorizationCode` (interactive consent + PKCE), deferred because the
  redirect capture is an app concern, so a user who needs a human-consent server
  must supply the token via `TokenSource` until phase 2. The `Auth` seam and the
  `McpAuthRequired` discovery error are built so that follow-up is additive, not
  a redesign. Spike the RFC 9728 / 8414 discovery against a real token-gated
  server early, since server conformance to the 2025-06-18 auth spec still
  varies.
- **stdio runtime portability.** `ChildProcess` is effect-smol's own primitive,
  so it should abstract the host, but verify a stdio server spawns and frames
  cleanly under Node, Bun, and Deno before claiming multi-runtime support in
  docs. If a recipe needs a runtime-specific spawn, name its runner files per
  the runtime convention (`run-node.ts` / `run-bun.ts` / `run-deno.ts`).
- **Result content fidelity.** Serializing non-text blocks to placeholders is a
  v1 compromise. Fine for the dominant text/JSON tools; revisit when the loop
  grows a multimodal tool-output path.
