---
title: Sandboxes
description: A contained OS your agent can exec into, stream stdout from, and read files out of — with destruction tied to an Effect Scope.
---

Sooner or later an agent wants to run code. Shell out, install a package,
execute the Python the model just wrote, leave a dev server running while
you poke at it. A sandbox is a contained OS you can do that against,
safely.

## Quickstart

Wire up a provider, create a sandbox, run a command:

```ts
import { Effect } from "effect"
import * as Sandbox from "@effect-uai/core/Sandbox"
import * as Image from "@effect-uai/core/SandboxImage"
import { layer as microsandboxLayer } from "@effect-uai/microsandbox/MicrosandboxSandbox"

const program = Effect.gen(function* () {
  const sb = yield* Sandbox.create({ image: Image.registry("python:3.12") })
  const out = yield* sb.exec({ cmd: ["python", "-c", "print(2 + 2)"] })
  yield* Effect.log(out.stdout) // "4\n"
})

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(microsandboxLayer({}))))
```

That's the whole story: provide a provider layer, `create` a sandbox,
`exec` a command, let the scope close — the sandbox is destroyed
automatically. From here, every section below answers one "how do I…"
question.

## Create and destroy

You don't call `destroy()` on a sandbox — it doesn't exist as a
method. Destruction is tied to an Effect `Scope`:

```ts
Effect.gen(function* () {
  const sb = yield* Sandbox.create({ image: Image.registry("python:3.12") })
  // … use sb …
}).pipe(Effect.scoped) // ← sandbox is destroyed here
```

Three idioms cover almost everything:

- **`Effect.scoped`** — destroy when this Effect finishes. The common case.
- **`Scope.make` + manual close** — when one sandbox should span many
  calls inside a larger program; close the scope when you're done.
- **`Sandbox.destroy(id)`** — escape hatch when you need to kill a
  sandbox from another fiber (or from outside its owning scope).

If you need a sandbox that outlives any single Effect, see
[long-lived sandboxes](#long-lived-sandboxes) further down.

## Pick an image

```ts
import * as Image from "@effect-uai/core/SandboxImage"

Image.auto // provider's house image
Image.registry("python:3.12") // OCI registry ref
Image.snapshot("ml-warm-1") // restore captured state (advanced)
Image.dockerfile("FROM ubuntu...") // build custom (advanced, provider-dependent)
```

`auto` is "I don't care, give me your default" — works on providers
with a fixed base, errors on providers that require an explicit ref.
For most agent work, you'll reach for `Image.registry(...)` with a
slim official image (`python:3.12`, `node:22`, `alpine`).

## CPU, memory, and other sizing knobs

Sizing varies a lot across providers, so these knobs live on each
provider's **typed tag**, not on the generic `Sandbox.create`. The
pattern is the same everywhere:

```ts
import { MicrosandboxSandbox } from "@effect-uai/microsandbox/MicrosandboxSandbox"

const sb =
  yield *
  Effect.flatMap(MicrosandboxSandbox, (msb) =>
    msb.create({
      image: Image.registry("python:3.12"),
      cpus: 2,
      memory: "1 GiB", // or 1024 * 1024 * 1024, or Memory.gib(1)
      idleTimeout: "5 minutes", // auto-shutdown when idle
    }),
  )
```

The same Layer registers both `Sandbox` (generic, portable) and
`MicrosandboxSandbox` (typed, provider-specific). Yield the generic
tag for code that should work across providers; yield the typed tag
when you need provider-specific knobs. Each provider's typed fields
live on its page — for Microsandbox, see
[the full request shape](/sandboxes/providers/microsandbox/#request-shape).

## Running commands

Three methods, three lifecycles:

| Method       | Lifetime             | Returns                                                | Reach for it when                                                |
| ------------ | -------------------- | ------------------------------------------------------ | ---------------------------------------------------------------- |
| `exec`       | one-shot, buffered   | `ExecResult` (exit, stdout, stderr, duration)          | short commands; you only care about the final result             |
| `execStream` | one-shot, streamed   | `Stream<ExecEvent>` (`Stdout` / `Stderr` / `Complete`) | live progress, log tail, piping output back into a model         |
| `spawn`      | scoped, long-running | `ProcessHandle` (`pid`, events, `kill`, `exit`)        | dev servers, watchers, `tail -f` — anything you start and forget |

```ts
// One-shot
const out = yield * sb.exec({ cmd: ["npm", "test"] })

// Streaming
yield *
  Stream.runForEach(sb.execStream({ cmd: ["npm", "run", "build"] }), (event) => /* … */ Effect.void)

// Long-running (killed on scope close)
const handle = yield * sb.spawn({ cmd: ["npm", "run", "dev"] })
```

`cmd` accepts a string (run through the guest shell) or an array
(direct argv, no shell parsing — safer when you're interpolating
user input).

## Reading and writing files

```ts
const fs = sb.files

yield * fs.write("/work/script.py", "print('hi')")
const bytes = yield * fs.read("/work/script.py") // Uint8Array
const exists = yield * fs.exists("/work/script.py") // boolean
const entries = yield * fs.list("/work") // ReadonlyArray<FileEntry>
yield * fs.mkdir("/work/out")
yield * fs.remove("/work/script.py")
```

`read` always returns `Uint8Array` (decode yourself — there's no
implicit text encoding); `write` accepts either `string` or
`Uint8Array`. Paths are absolute inside the guest OS.

## Inject secrets

You probably want your sandbox to call OpenAI / GitHub / your internal
API. The naive option is `env: { OPENAI_KEY: "sk-..." }` — but now
the secret is in the guest's environment, visible to every process
the LLM spawns. If the model writes a script that prints `process.env`
(or just runs `env`), the key goes into the model's context window
and from there to your logs, your traces, anywhere the conversation
ends up.

`BoundSecret` solves this by **never letting the secret enter the
guest**:

```ts
import { Redacted } from "effect"

const sb =
  yield *
  Sandbox.create({
    image: Image.registry("node:22"),
    secrets: [
      {
        name: "OPENAI_KEY", // placeholder name inside the guest
        value: Redacted.make("sk-..."),
        hosts: ["api.openai.com"], // injected only on requests to these hosts
      },
    ],
  })
```

Inside the sandbox, code reads a **placeholder** that looks like the
secret but isn't — e.g. Microsandbox exposes `$MSB_OPENAI_KEY`. When
the guest makes an HTTPS request to a host in `hosts`, the provider's
egress proxy substitutes the real value into the `Authorization`
header on the way out. The guest never holds the real string; logs,
`env`, and process inspection can't leak it.

Three things to know:

- **`hosts` is the safety boundary.** A leaked secret is only useful
  on hosts you bound it to. Scope tight — `["api.openai.com"]`, not
  `["*"]`.
- **`value` is `Redacted.Redacted`, never raw `string`.** It stays
  redacted in logs and traces until the adapter unwraps it for the
  proxy.
- **Capability-gated.** Providers without proxy-layer rewriting (Modal,
  Daytona, CodeSandbox) don't ship the `SandboxSecretInjection`
  marker — calls fail at `Effect.provide` with a type error.

## Restrict network traffic

```ts
import * as Network from "@effect-uai/core/SandboxNetwork"

Network.open                                  // provider defaults apply
Network.blocked                               // airgapped — no egress at all
Network.allowHosts("api.openai.com", "github.com")
Network.allowCidrs("10.0.0.0/8")
Network.allow({ hosts: [...], cidrs: [...] }) // mixed
```

Pass the result as `network` on create:

```ts
const sb =
  yield *
  Sandbox.create({
    image: Image.registry("node:22"),
    network: Network.allowHosts("api.openai.com"),
  })
```

`open` doesn't mean "anything goes" — most providers still block
private ranges by default; it just means "don't layer extra rules on
top." Use `blocked` for sandboxes that should never call out (running
fully untrusted code with no API needs). Hostname allowlists require
the `SandboxHostnameAllowlist` capability; CIDR allowlists work
everywhere.

---

That's the getting-started surface. The sections below cover advanced
patterns — most agents won't need them at first.

## Capabilities

Providers vary a lot under the hood. Microsandbox runs a local
microVM; Vercel boots AL2023 with no custom image; E2B preserves RAM
across pause/resume; Modal speaks CIDR allowlists but not hostnames.
To make those gaps visible at the layer boundary (rather than halfway
through a demo) each gap is its own capability tag on the `R` channel:

| Marker                     | What gating it means                                         |
| -------------------------- | ------------------------------------------------------------ |
| `SandboxSnapshots`         | `snapshot(from)` is available                                |
| `SandboxVolumes`           | named persistent volumes outside any sandbox lifecycle       |
| `SandboxSecretInjection`   | proxy-layer header rewriting; the guest never sees the value |
| `SandboxHostnameAllowlist` | egress allowlist by host name (not just CIDR)                |
| `SandboxPauseResume`       | in-place pause that preserves RAM and processes              |
| `SandboxCustomImage`       | user-supplied Dockerfile, not just a registry ref            |
| `SandboxPortExposure`      | runtime "expose port N as a URL"                             |
| `SandboxKernelSession`     | Jupyter-style stateful kernel with rich outputs              |
| `SandboxPty`               | interactive PTY session                                      |

Calling a gated helper while only an unmarked Layer is in scope is a
**type error at `Effect.provide`**, not a runtime failure. The matching
provider rows live on each provider's page.

## Long-lived sandboxes

The scope-bound default is right most of the time, but two cases want
a sandbox that survives past the calling Effect:

- **Reusing across many runs** — pay the cold-start once, hand the
  same sandbox to many calls.
- **Surviving a process exit** — start it from one CLI invocation,
  talk to it from another.

```ts
// Create with detached: true — scope finalizer skips destroy.
const sb =
  yield *
  msb.create({
    name: "agent-sandbox",
    image: Image.registry("python:3.12"),
    detached: true,
  })

// Later — different fiber, different process, doesn't matter:
const sb = yield * Sandbox.attach(SandboxId("agent-sandbox"))
```

- `detached: true` is a **provider-specific** create flag (Microsandbox
  ships it today). The scope finalizer drops the connection without
  destroying the sandbox.
- `Sandbox.attach(id)` re-acquires an existing sandbox. The handle is
  scoped, but the finalizer detaches rather than destroys.
- Pair `detached` with an explicit `name` so `attach` has a stable
  id to look up.
- Cleanup is now your job — `Sandbox.destroy(id)` from anywhere, or
  the provider's CLI (`msb sandbox stop ...`).

## Volumes and snapshots

Two ways to keep state across sandbox lifetimes — they answer
different questions:

- **Volume** — "a persistent directory I can mount into many
  sandboxes." Named, lives outside any single sandbox's lifecycle.
  Good for caches, model weights, shared datasets. Requires
  `SandboxVolumes`.
- **Snapshot** — "capture this sandbox's filesystem state and restore
  it as a fresh sandbox later." Used via `Image.snapshot(id)` at
  create time. Good for warm-starts (pre-installed deps, cached
  imports). Requires `SandboxSnapshots`.

```ts
// Volume: create once, mount into many sandboxes.
const volumeId = yield * Sandbox.createVolume("ml-models")
const sb =
  yield *
  Sandbox.create({
    image: Image.registry("python:3.12"),
    volumes: [{ id: volumeId, mountPath: "/models" }],
  })

// Snapshot: capture state, restore as a derived sandbox.
const snapId = yield * Sandbox.snapshot(sb, "deps-installed")
const warm = yield * Sandbox.create({ image: Image.snapshot(snapId) })
```

Snapshots are **not** pause/resume. Restoring a snapshot gives you a
fresh sandbox id with the same filesystem — RAM and running processes
are lost. In-place pause that preserves both lives behind a separate
marker (`SandboxPauseResume`), supported by E2B and CodeSandbox but
not by every provider that has snapshots.

## Provider matrix

| Provider      | Snapshots               | Volumes        | Secrets | Hostname allowlist | Pause/Resume | Custom image | Port exposure        |
| ------------- | ----------------------- | -------------- | ------- | ------------------ | ------------ | ------------ | -------------------- |
| Microsandbox  | ✓                       | ✓              | ✓       | ✓                  | —            | —            | — (create-time only) |
| Deno Sandbox  | ◐ (volume-derived)      | ✓ (`ord` only) | ✓       | ✓ (no CIDRs)       | —            | —            | ✓                    |

More providers (Vercel, E2B, Modal, Cloudflare, Daytona) land as
their adapters ship; the matrix grows downward, not the API surface.

## What `Sandbox` is not

- **Not a container orchestrator.** No scheduling, no service mesh,
  no multi-replica anything. One sandbox, one handle.
- **Not a deployment target.** Sandboxes are ephemeral by design —
  the scope finalizer destroys them. Use a real platform for
  long-lived services.
- **Not a kernel session.** Jupyter-style rich output is a separate
  capability (`SandboxKernelSession`) and a separate runner, not
  `exec`. Coming with providers that support it.

## Next step

Wire up an adapter:

- **[Microsandbox](/sandboxes/providers/microsandbox/)** — local
  microVM runtime, no API key, runs against the `msb` daemon on your
  machine.
- **[Deno Sandbox](/sandboxes/providers/deno/)** — cloud microVM on
  the Deno Deploy edge with sub-second boot, hostname-allowlist
  egress, proxy-injected secrets, and public preview URLs.
