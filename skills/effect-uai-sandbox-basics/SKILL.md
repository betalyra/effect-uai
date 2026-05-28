---
name: effect-uai-sandbox-basics
description: Use when the user wants to run untrusted code (LLM-generated scripts, user-submitted snippets, agent shell commands) inside an isolated microVM. Covers picking a provider (Microsandbox locally vs Deno Deploy hosted), provisioning a sandbox with a chosen OCI image and network policy, and executing commands. Pair with `effect-uai-streaming-tool-output` to expose a sandbox to a model as a tool.
license: MIT
---

# effect-uai sandbox-basics

`@effect-uai/core/Sandbox` exposes a `SandboxService` for booting
short-lived microVMs, running commands inside them, and tearing them
down. Two adapter packages implement it today:

| Package                    | Where the VM runs                                 | Best for                                  |
| -------------------------- | ------------------------------------------------- | ----------------------------------------- |
| `@effect-uai/microsandbox` | Local Firecracker microVM (`microsandbox` daemon) | Local dev, integration tests, self-hosted |
| `@effect-uai/deno`         | Hosted Firecracker microVM on Deno Deploy         | Production, on-demand, no infra to run    |

Both implement the same `SandboxService` apart from the `create`
request shape (provider-specific knobs); everything else — `exec`,
`execStream`, volumes, snapshots, ports, secrets — is interchangeable
behind a Layer swap.

Reach for this when the user says any of:

- "I want to run untrusted code / LLM-generated scripts safely"
- "Give the model a Python (or shell) tool with isolation"
- "I need an isolated execution environment per agent run"
- "Switch from local microsandbox to hosted Deno sandboxes" (or vice versa)

## Provision a sandbox

```ts
import { Effect } from "effect"
import * as Sandbox from "@effect-uai/core/Sandbox"
import * as Image from "@effect-uai/core/SandboxImage"
import * as Network from "@effect-uai/core/SandboxNetwork"

const program = Effect.gen(function* () {
  const sb = yield* Sandbox.create({
    image: Image.registry("python:3.12-slim"),
    network: Network.blocked, // airgapped — no outbound network
  })

  const result = yield* sb.exec({ cmd: ["python3", "-c", "print(2 + 2)"] })
  console.log(result.stdout) // "4"
}).pipe(Effect.scoped) // <- destroys the sandbox when scope closes
```

`Effect.scoped` is what binds the sandbox's lifetime to this block.
Skip it and the sandbox stays alive until a wider scope closes.

### Image options

```ts
Image.auto // provider default
Image.registry("python:3.12-slim") // any OCI image
Image.snapshot(snapshotId) // restore a previous capture (capability-gated)
Image.dockerfile(`FROM python:3.12 ...`) // build custom (capability-gated)
```

### Network options

```ts
Network.open // unrestricted (provider defaults still apply)
Network.blocked // no egress at all
Network.allowHosts("api.openai.com") // hostname allowlist (capability-gated)
Network.allowCidrs("10.0.0.0/8") // CIDR allowlist
```

## Exec patterns

```ts
// One-shot, blocks until done.
const r = yield * sb.exec({ cmd: ["bash", "-c", "ls -la"] })
// r: { exitCode, stdout, stderr, durationMs }

// Streaming stdout/stderr as it arrives.
yield *
  sb.execStream({ cmd: ["pip", "install", "numpy"] }).pipe(
    Stream.runForEach(
      (ev) =>
        ev._tag === "Stdout"
          ? Effect.sync(() => process.stdout.write(ev.data))
          : ev._tag === "Stderr"
            ? Effect.sync(() => process.stderr.write(ev.data))
            : Effect.void, // Exit event
    ),
  )
```

## Pick a provider (Layer wiring)

### Local — Microsandbox

```ts
import { layer as microsandboxLayer } from "@effect-uai/microsandbox/MicrosandboxSandbox"

const mainLayer = microsandboxLayer({
  defaultImage: "python:3.12-slim", // optional fallback when create omits `image`
})

Effect.runPromise(program.pipe(Effect.provide(mainLayer)))
```

Requires a running `microsandbox` daemon (`msb` CLI). See
[microsandbox](https://github.com/microsandbox/microsandbox) for setup.

### Hosted — Deno Deploy

```ts
import { Config, Effect, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as denoSandboxLayer } from "@effect-uai/deno/DenoSandbox"

const mainLayer = Effect.gen(function* () {
  const token = yield* Config.redacted("DENO_DEPLOY_TOKEN")
  const org = yield* Config.string("DENO_DEPLOY_ORG")
  return denoSandboxLayer({ token, org })
}).pipe(Layer.unwrapEffect, Layer.provide(FetchHttpClient.layer))
```

Needs a Deno Deploy token + org. Personal `ddp_` tokens require `org`;
organization `ddo_` tokens have it implicit.

## Exposing a sandbox to a model as a tool

The classic pattern — agent writes Python, sandbox runs it, the result
goes back into the next turn. This is the "run, fix, repeat" loop.
Combine with [`effect-uai-streaming-tool-output`](../effect-uai-streaming-tool-output/SKILL.md)
if you want the agent to see live stdout while the script runs.

```ts
import * as Tool from "@effect-uai/core/Tool"
import { Schema } from "effect"

const makeRunPython = (sb: Sandbox.SandboxInstance) =>
  Tool.make({
    name: "run_python",
    description: "Run Python in an isolated microVM. Returns exitCode, stdout, stderr.",
    inputSchema: Tool.fromEffectSchema(Schema.Struct({ code: Schema.String })),
    run: ({ code }) =>
      sb.exec({ cmd: ["python3", "-c", code] }).pipe(
        Effect.map((r) => ({
          exitCode: r.exitCode,
          stdout: r.stdout.trim(),
          stderr: r.stderr.trim(),
        })),
      ),
    strict: true,
  })
```

Then build the agent loop with `effect-uai-basic-usage`, passing the
tool descriptor along with the rest.

## Anti-patterns

- **Don't share a sandbox across agent runs without snapshotting.**
  Sandboxes accumulate state; each agent run should provision its own
  (or `attach` to one that was explicitly preserved with a snapshot).
- **Don't drop `Effect.scoped`.** Without it the sandbox doesn't get
  destroyed when the program exits — you'll leak microVMs (and bill).
- **Don't reach for `Network.open` by default.** The model can write
  any code; defaulting to `Network.blocked` and explicitly allowing
  hosts via `Network.allowHosts(...)` keeps things tight.
- **Don't use snapshot/pause-resume APIs without checking capabilities.**
  `Sandbox.snapshot(...)` needs `SandboxSnapshots` in `R`; calls fail
  at compile time on providers that don't ship the marker.

## See also

- Recipe source: `recipes-extras/sandbox-code-interpreter/index.ts`
- For exposing the exec as a streaming tool: `effect-uai-streaming-tool-output`
- For the basic agent loop the sandbox tool plugs into: `effect-uai-basic-usage`
