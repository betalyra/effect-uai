---
title: Microsandbox
description: Local microVM sandbox provider — no API key, no cloud, runs against the msb daemon on your machine.
---

[Microsandbox](https://microsandbox.dev) boots real microVMs locally
(KVM on Linux, Apple Hypervisor on macOS) — fast cold start, kernel
isolation, no network round-trip. This adapter wraps its
[`microsandbox`](https://www.npmjs.com/package/microsandbox) Node SDK
and maps it onto the core `SandboxService` shape.

Good fit for: local dev, CI runners, anywhere "no API key, no cloud
account" matters. Less good fit for: production multi-tenant workloads
(use a managed provider).

## Install

```sh
pnpm add @effect-uai/core @effect-uai/microsandbox microsandbox effect
```

You also need the `msb` runtime running on the host:

```sh
npx microsandbox install   # one-time
msb server start           # leaves the daemon running
```

Requirements: Linux with KVM, or macOS on Apple Silicon. Node ≥ 22
(the SDK uses `await using` / `Symbol.asyncDispose`).

## Wire it up

```ts
import { Effect, Layer } from "effect"
import { layer as microsandboxLayer } from "@effect-uai/microsandbox/MicrosandboxSandbox"

const provider = microsandboxLayer({
  defaultImage: "python:3.12", // optional — fallback when request omits `image`
})
```

`microsandboxLayer` registers two service tags and four capability
markers from one underlying implementation:

- **`MicrosandboxSandbox`** — the typed tag. Yield this for the
  narrowed request shape (`cpus`, `memoryMib`, `replace`, `detached`,
  `idleTimeout`, …).
- **`Sandbox`** — the generic tag. Yield this for provider-portable
  code; only `CommonCreateRequest` is accepted at the call site.
- Capability markers shipped: `SandboxSnapshots`, `SandboxVolumes`,
  `SandboxSecretInjection`, `SandboxHostnameAllowlist`. See
  [capabilities](#capabilities) below.

## Config

```ts
interface MicrosandboxConfig {
  readonly defaultImage?: string
}
```

There's no API key — the daemon is local. `defaultImage` is the OCI
ref used when a create request omits `image` (or sets it to
`ImageRef.Default`). Leaving it unset is fine if every call site
supplies its own image.

## Request shape

```ts
interface MicrosandboxCreateRequest extends Omit<CommonCreateRequest, "secrets"> {
  readonly secrets?: ReadonlyArray<MicrosandboxBoundSecret> // no `header` field
  readonly name?: string // explicit id (else auto-generated)
  readonly cpus?: number
  readonly memoryMib?: number
  readonly workdir?: string
  readonly user?: string
  readonly maxDuration?: Duration.Input // hard wall-clock cap
  readonly idleTimeout?: Duration.Input // auto-shutdown when idle
  readonly replace?: boolean | { readonly graceMs: number }
  readonly detached?: boolean
}
```

On top of [`CommonCreateRequest`](/sandboxes/#picking-an-image)
(`image`, `timeout`, `env`, `network`, `volumes`):

- **`name`** — explicit sandbox id. Microsandbox keys by name; omit it
  and the adapter generates `eff-uai-<random>`.
- **`cpus` / `memoryMib`** — VM sizing. Defaults come from the SDK
  builder.
- **`workdir` / `user`** — process cwd and effective user inside the
  guest.
- **`maxDuration`** — hard wall-clock cap on the sandbox. Distinct
  from `timeout` on `CommonCreateRequest`, which the adapter also maps
  here (both round up to whole seconds for the SDK).
- **`idleTimeout`** — auto-shutdown after this much idle time. Useful
  for "leave it running, but cap the bill" semantics.
- **`replace`** — if a sandbox with the same `name` is alive, stop it
  first. `true` uses the SDK's default grace; `{ graceMs }` waits then
  `SIGKILL`s.
- **`detached`** — see [detached sandboxes](#detached-sandboxes) below.

### Detached sandboxes

```ts
const sb =
  yield *
  msb.create({
    name: "long-running",
    image: Image.registry("python:3.12"),
    detached: true, // ← survives scope close
  })
```

The default lifetime model destroys the sandbox when its scope closes.
`detached: true` skips that — the scope finalizer just drops the
connection, and the microVM keeps running. Clean up later with
`Sandbox.destroy(id)` or via `msb sandbox stop`.

Pair `detached` with `name` so you can `attach(id)` back to it in a
later Effect.

### Secrets

See the [secrets section](/sandboxes/#secrets-—-what-theyre-for-and-why-a-placeholder)
in the overview for what `BoundSecret` is and why it exists.

```ts
const sb =
  yield *
  msb.create({
    image: Image.registry("node:22"),
    secrets: [
      {
        name: "OPENAI_KEY", // exposed as $MSB_OPENAI_KEY in the guest
        value: Redacted.make("sk-..."),
        hosts: ["api.openai.com"], // only injected on requests to these hosts
      },
    ],
  })
```

Microsandbox-specific notes:

- **Placeholder shape**: secrets surface inside the guest as
  `$MSB_<NAME>`. Reference them via the environment, not by interpolating
  the real value — the real value isn't there.
- **Header fixed to `Authorization: Bearer <value>`**. No per-secret
  custom header. The typed `MicrosandboxBoundSecret` omits the `header`
  field at the type level; calls through the generic `Sandbox.create`
  surface that set `header` fail loudly with `SandboxUnsupported`
  rather than silently dropping it.

## Capabilities

| Marker                     | Shipped | Notes                                                                                              |
| -------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| `SandboxSnapshots`         | ✓       | `snapshot(from)` flushes + stops + captures + indexes.                                             |
| `SandboxVolumes`           | ✓       | Named persistent volumes; `quotaBytes` rounded up to MiB.                                          |
| `SandboxSecretInjection`   | ✓       | `Authorization: Bearer` only; see [secrets](#secrets).                                             |
| `SandboxHostnameAllowlist` | ✓       | `allowDomain` rules in the policy builder.                                                         |
| `SandboxPauseResume`       | —       | `stop()` + `start()` resumes from disk, not RAM. Different semantics.                              |
| `SandboxCustomImage`       | —       | OCI registry refs and snapshots only — no Dockerfile.                                              |
| `SandboxPortExposure`      | —       | Ports forward at **create** time via the SDK's port mapping; runtime `exposePort` isn't supported. |
| `SandboxKernelSession`     | —       | No Jupyter/REPL surface.                                                                           |
| `SandboxPty`               | —       | Use `execStream` for byte-oriented IO.                                                             |

Calling `snapshot(from)` or `exposePort(instance, port)` against an
unmarked layer is a **compile-time** error, not a runtime
`SandboxUnsupported`. The unmarked-but-attempted case only fires if
you reach into `service.ports.expose` directly past the marker check.

## Errors

| SDK / runtime failure              | Mapped to                      |
| ---------------------------------- | ------------------------------ |
| `SandboxStillRunningError`         | `SandboxAlreadyExists`         |
| `SandboxNotFoundError`             | `SandboxNotFound`              |
| `ExecTimeoutError`                 | `SandboxTimeout` (`exec`)      |
| Filesystem failure                 | `SandboxExecFailed`            |
| Dockerfile request                 | `SandboxUnsupported` (`image`) |
| Missing image + no `defaultImage`  | `SandboxUnsupported` (`image`) |
| Empty argv array                   | `SandboxInvalidRequest`        |
| Custom secret `header` via generic | `SandboxUnsupported`           |
| Anything else on create / lookup   | `SandboxCreateFailed`          |

Recover per-tag with `Effect.catchTag` / `Stream.catchTag`. The
post-kill DB sync race (Microsandbox 0.4.6: ~200 ms between `kill()`
and `status === "stopped"`) is handled inside the adapter via
exponential-backoff retry — you don't see it.

## Known quirks

- **Snapshots flush filesystem writes first.** `fs().write` data sits
  in page cache until `sync` runs; the adapter shells out `sync` before
  stop so the snapshot isn't empty. Workaround for upstream issue
  [#746](https://github.com/microsandbox/microsandbox/pull/746), which
  fixes flushing in-process; remove the workaround when the SDK is bumped.
- **`pid` on `ProcessHandle` is `0`.** Microsandbox emits the real pid
  on its `started` event, but the SDK doesn't surface it via a sync
  getter. Will be filled in when the SDK does.
- **Daemon must be running.** `msb server start` once per host session.
  If the daemon is down, `create` fails with `SandboxCreateFailed`.
