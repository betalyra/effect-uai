---
title: Deno Sandbox
description: Cloud microVM sandbox on the Deno Deploy edge — sub-second boot, hostname-allowlist egress, proxy-injected secrets, public preview URLs.
---

[Deno Sandbox](https://docs.deno.com/sandbox/) provisions Firecracker
microVMs on the Deno Deploy edge — sub-second boot, hostname-level
egress allowlist, proxy-injected secrets, and one-call public preview
URLs. This adapter wraps the
[`@deno/sandbox`](https://www.npmjs.com/package/@deno/sandbox) Node
SDK and maps it onto the core `SandboxService` shape. The SDK runs
fine from plain Node — you do **not** need to use the Deno runtime to
use this provider.

Good fit for: agent code-exec with a clean secret-injection story,
preview-URL workflows ("the model built a server — share the URL"),
no-local-infra deployments. Less good fit for: workloads that need
custom OCI images (Deno only takes default base + snapshots) or
sandboxes that must run longer than 30 minutes.

## Install

```sh
pnpm add @effect-uai/core @effect-uai/deno @deno/sandbox effect
```

Requirements: Node ≥ 22 (the SDK uses `await using` /
`Symbol.asyncDispose`). A Deno Deploy account at
<https://console.deno.com> and an access token from **Settings →
Organization tokens** (`ddo_…` — works on its own) or
**Personal tokens** (`ddp_…` — also needs `DENO_DEPLOY_ORG`).

## Wire it up

Set `DENO_DEPLOY_TOKEN` in env and the SDK picks it up automatically:

```ts
import { Effect, Layer } from "effect"
import { layer as denoLayer } from "@effect-uai/deno/DenoSandbox"

const provider = denoLayer({
  defaultRegion: "ord", // optional — applied when a request omits `region`
})
```

Or pass the token explicitly via the layer config (useful if you read
it from a secret manager rather than env):

```ts
import { Redacted } from "effect"

const provider = denoLayer({
  token: Redacted.make(process.env.MY_DEPLOY_TOKEN!),
  org: "my-org-slug", // required for personal `ddp_` tokens
  defaultRegion: "ord",
})
```

`denoLayer` registers two service tags and five capability markers
from one underlying implementation:

- **`DenoSandbox`** — the typed tag. Yield this for the narrowed
  request shape (`region`, `memory`, `labels`, `port`, …).
- **`Sandbox`** — the generic tag. Yield this for provider-portable
  code; only `CommonCreateRequest` is accepted at the call site.
- Capability markers shipped: `SandboxHostnameAllowlist`,
  `SandboxSecretInjection`, `SandboxSnapshots` (read-side only),
  `SandboxVolumes`, `SandboxPortExposure`. See
  [capabilities](#capabilities) below.

## Config

```ts
interface DenoSandboxConfig {
  readonly token?: Redacted.Redacted<string> // overrides DENO_DEPLOY_TOKEN
  readonly org?: string // overrides DENO_DEPLOY_ORG
  readonly apiEndpoint?: string // overrides DENO_DEPLOY_ENDPOINT
  readonly defaultRegion?: "ord" | "ams"
}
```

All four fields are optional. The SDK reads `DENO_DEPLOY_TOKEN` /
`DENO_DEPLOY_ORG` / `DENO_DEPLOY_ENDPOINT` from env by default; pass
the corresponding config field to override.

## Request shape

```ts
interface DenoSandboxCreateRequest extends Omit<CommonCreateRequest, "secrets"> {
  readonly secrets?: ReadonlyArray<DenoSandboxBoundSecret> // no `header` field
  readonly region?: "ord" | "ams"
  readonly memory?: Memory.Input // bytes, branded Memory, or "1280 MiB"
  readonly labels?: Readonly<Record<string, string>>
  readonly port?: number // auto-exposed at boot; `sandbox.url` reaches it
}
```

On top of [`CommonCreateRequest`](/sandboxes/#pick-an-image)
(`image`, `timeout`, `env`, `network`, `volumes`):

- **`region`** — `"ord"` (Chicago) or `"ams"` (Amsterdam). Falls back
  to the layer's `defaultRegion`, then to the org's default. Volumes
  are currently `"ord"`-only.
- **`memory`** — accepts a byte count, a
  [`Memory`](/sandboxes/#memory-and-sizing-knobs) branded value, or
  a human string like `"1280 MiB"` / `"1 GiB"`. Deno's accepted range
  at GA is 768 MiB – 4 GiB (default ~1.2 GiB).
- **`labels`** — up to 5 key/value pairs for filtering in
  `Sandbox.list` and the Deploy dashboard. Keys ≤ 64 bytes, values
  ≤ 128 bytes.
- **`port`** — auto-expose this internal port at boot; the live
  sandbox's `url` reaches it. Equivalent to calling
  [`Sandbox.exposePort`](/sandboxes/#expose-an-internal-port) after
  the fact, but available immediately without an extra round-trip.

### Timeouts

Deno's `timeout` accepts `"session"` (lives only while the SDK is
connected — the default) or a duration like `"5m"` / `"300s"`. The
adapter normalizes `CommonCreateRequest.timeout` (`Duration.Input`)
to whole seconds before handing off:

```ts
const sb = yield * Sandbox.create({ timeout: "10 minutes" })
// → mapped to `timeout: "600s"` on the SDK
```

Max lifetime is 30 minutes; extend a live sandbox via the SDK's
`extendTimeout` if you need longer.

### Secrets

See the [secrets section](/sandboxes/#inject-secrets) in the overview
for what `BoundSecret` is and why it exists.

```ts
const sb =
  yield *
  Sandbox.create({
    secrets: [
      {
        name: "OPENAI_API_KEY",
        value: Redacted.make("sk-..."),
        hosts: ["api.openai.com"],
      },
    ],
  })
```

Deno-specific notes:

- **Placeholder shape**: secrets surface inside the guest as opaque
  placeholders — the real value materializes only on outbound HTTPS to
  a host in `hosts`. The exact placeholder format is provider-internal;
  don't try to parse or interpolate it.
- **Header fixed to `Authorization: Bearer <value>`**. No per-secret
  custom header. The typed `DenoSandboxBoundSecret` omits the `header`
  field at the type level; calls through the generic `Sandbox.create`
  surface that set `header` fail loudly with `SandboxUnsupported`.

### Network policy

Deno accepts hostnames (with wildcards) and literal IPv4 / IPv6 — but
**no CIDR ranges**. The adapter rejects `cidrs` at decode time rather
than silently truncating:

```ts
import * as Network from "@effect-uai/core/SandboxNetwork"

Network.allowHosts("api.openai.com", "*.anthropic.com") // ✓
Network.allowCidrs("10.0.0.0/8") // ✗ → SandboxUnsupported
```

`Network.blocked` (no egress at all) and `Network.open` (provider
defaults) both work.

### Snapshots

Deno snapshots are **derived from volumes**, not from running
sandboxes — you create a bootable volume, install software into a
sandbox booted from it, then snapshot the volume. The generic
[`Sandbox.snapshot(from, name)`](/sandboxes/#volumes-and-snapshots)
helper doesn't fit this shape and fails with `SandboxUnsupported`:

```ts
// ✗ — fails with SandboxUnsupported at runtime
yield * Sandbox.snapshot(sb, "my-snapshot")

// ✓ — use the per-provider escape hatch
const deno = yield * DenoSandbox.asEffect()
const snapId = yield * deno.snapshotVolume(volumeId, "my-snapshot")
```

The read-side helpers (`listSnapshots`, `destroySnapshot`) work as
usual. Boot a sandbox from a snapshot via `Image.snapshot(slug)` (the
SDK accepts snapshot slugs as the `root` field).

### Volumes

Standard volume API works — `createVolume(name)` / `destroyVolume(id)`
/ `listVolumes`, mount via `volumes: [{ id, mountPath }]` on create.
A couple of Deno-specific constraints:

- Volumes are currently **`ord`-only**; the adapter defaults to that
  region for `createVolume`. To pre-create in `ams` (when it becomes
  available), drop down to the SDK's `client.volumes.create` directly.
- Deno mounts volumes **read-write only** — the
  `readonly: true` field on the `volumes` array fails with
  `SandboxUnsupported`.

### Expose ports

`Sandbox.exposePort(sb, port)` returns a real public HTTPS URL under
`*.sandbox.deno.net` — no extra config:

```ts
yield * sb.spawn({ cmd: ["deno", "run", "-NE", "/tmp/server.ts"] })
const { url } = yield * Sandbox.exposePort(sb, 8000)
// → https://<hash>.sandbox.deno.net
```

The URL stays live for the sandbox lifetime. **Public, unauthenticated**
— anyone with the URL can hit the service. Use the
`port: 8000` field on create to auto-expose at boot if you don't want
the extra round-trip.

## Capabilities

| Marker                     | Shipped | Notes                                                                      |
| -------------------------- | ------- | -------------------------------------------------------------------------- |
| `SandboxHostnameAllowlist` | ✓       | Hostnames + wildcards + literal IPs. No CIDRs.                             |
| `SandboxSecretInjection`   | ✓       | `Authorization: Bearer` only; see [secrets](#secrets).                     |
| `SandboxSnapshots`         | ◐       | Read side only. `create(from)` fails — use `snapshotVolume(volumeId)`.     |
| `SandboxVolumes`           | ✓       | Volumes live in `ord` at present; read-write mounts only.                  |
| `SandboxPortExposure`      | ✓       | Runtime `exposeHttp` returns a public URL.                                 |
| `SandboxPauseResume`       | —       | No in-place memory-preserving pause.                                       |
| `SandboxCustomImage`       | —       | Default base or snapshots only — no Dockerfile, no OCI registry refs.      |
| `SandboxKernelSession`     | —       | No Jupyter/REPL surface.                                                   |
| `SandboxPty`               | —       | Use `execStream` for byte-oriented IO.                                     |

Calling `snapshot(from)` or `exposePort(instance, port)` against an
unmarked layer is a **compile-time** error, not a runtime
`SandboxUnsupported`.

## Errors

| SDK / runtime failure                                  | Mapped to                                    |
| ------------------------------------------------------ | -------------------------------------------- |
| `MissingTokenError` / `InvalidTokenError` / 401 / 403  | `SandboxAuthFailed`                          |
| 429                                                    | `SandboxQuotaExceeded`                       |
| 404 / `SANDBOX_ALREADY_TERMINATED`                     | `SandboxNotFound`                            |
| `InvalidTimeoutError` / `InvalidMemoryError`           | `SandboxInvalidRequest`                      |
| `SandboxCommandError` / `ConnectionClosedError`        | `SandboxExecFailed`                          |
| `ImageRef.Registry` / `Dockerfile`                     | `SandboxUnsupported` (`image.*`)             |
| `NetworkPolicy.Allowlist` with `cidrs`                 | `SandboxUnsupported` (`network.cidrs`)       |
| Volume mount with `readonly: true`                     | `SandboxUnsupported` (`volumes.readonly`)    |
| Custom secret `header` via generic surface             | `SandboxUnsupported` (`BoundSecret.header`)  |
| `Sandbox.snapshots.create(from)` via generic surface   | `SandboxUnsupported` (`snapshots.create`)    |
| Empty argv array                                       | `SandboxInvalidRequest`                      |
| Anything else on create / lookup                       | `SandboxCreateFailed`                        |

Recover per-tag with `Effect.catchTag` / `Stream.catchTag`. The
transient WebSocket-handshake 500 the Deploy edge occasionally
returns on `spawn` (`SANDBOX_WEBSOCKET_HANDSHAKE_ERROR`) is handled
inside the adapter via exponential-backoff retry (3 attempts) — you
don't see it.

## Known quirks

- **Pre-release concurrency cap.** Deno Deploy currently allows up to
  5 sandboxes per org concurrently. Long-running test suites should
  serialize creates or fan in/out carefully. Will lift.
- **No custom images.** Snapshots are the only "pre-installed deps"
  story — install once into a volume, snapshot, then boot fresh
  sandboxes from the snapshot. No equivalent of
  `Image.registry("python:3.12")`.
- **`timeout: "session"` is the default.** The sandbox lives only as
  long as the SDK keeps its connection open. Pass an explicit
  `timeout` if you intend to disconnect and reconnect via `attach`.
- **Volumes only in `ord` (as of 2026-05).** `createVolume` defaults
  to `ord`; multi-region volumes when the platform supports them.
