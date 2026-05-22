# Sandbox Provider Landscape — Code Execution

Planning doc for adding a code-execution **Sandbox** provider abstraction to `effect-uai`, mirroring the existing `LanguageModel` / `SpeechSynthesizer` / `Transcriber` services.

Compiled 2026-05-21. Pricing, model/template names, and SDK shapes change quickly — always re-verify against the linked source before relying.

## Why this exists

Modern LLM agents routinely need to execute model-authored code, run shell commands, install packages, snapshot state across turns, and call external APIs from inside the sandbox. The provider landscape has crystallized — the major cloud labs (Vercel, Cloudflare, Modal, E2B, Daytona, CodeSandbox, Runloop) each ship a "create a sandbox, exec into it, read/write files, expose ports" API, plus a few local microVM options that match capability-for-capability (Microsandbox, BoxLite, Gondolin). We want one Effect-shaped service that callers can wire any of them behind.

The non-goals: we are **not** wrapping hosted model-side code interpreters (OpenAI's `code_interpreter` tool, Anthropic's `code_execution` tool, Gemini code-execution). Those are _tools the model invokes_; they belong in `@effect-uai/<provider>` as native tool-shape adapters, not in a `Sandbox` provider layer.

## Scope

**In scope**

- Long-lived programmable Linux sandboxes with shell `exec`, filesystem R/W, port exposure, and lifecycle (`create` → `destroy`).
- Capability extensions: snapshots/fork, persistent volumes, hostname-allowlist egress, proxy-layer secret injection, kernel-style REPL sessions, PTY/terminal sessions, custom images.
- Both cloud and local providers under one interface.

**Out of scope (initial pass)**

- Hosted model-side interpreters (OpenAI, Anthropic, Gemini built-in code execution).
- "Deploy code and invoke" providers (Deno Subhosting v2, the Gemini `code-execution` tool) — different shape; route through a separate `CodeRunner` interface if needed later. **Note: Deno _Sandbox_ — the separate Feb 2026 product — is in scope.**
- Browser-only sandboxes (Pyodide, StackBlitz WebContainers) — different runtime, different consumers; potential future `@effect-uai/sandbox-browser` package.
- Pure JS evaluators (`isolated-vm`) — not "run untrusted Python with packages"; potential future JS-only adapter.
- Kubernetes-backed agent farms (BrowserBase, Northflank etc.) — out of scope until there's a concrete user.

---

## Provider-by-provider state

For each provider: the primitive, lifecycle, what kind of execution it offers, persistence model, security posture (egress + secret injection), image model, and TS SDK readiness.

### Vercel Sandbox — `@vercel/sandbox`

Verified against [docs.vercel.com/vercel-sandbox](https://vercel.com/docs/vercel-sandbox) (last updated 2026-03-13) and [SDK reference](https://vercel.com/docs/vercel-sandbox/sdk-reference) (2026-03-09).

- **Primitive**: Firecracker microVM on Amazon Linux 2023. Each sandbox runs as the `vercel-sandbox` user with sudo + working dir `/vercel/sandbox`.
- **Lifecycle**: `Sandbox.create()` → `runCommand()` / `writeFiles()` → `stop()`. **Persistent sandboxes is now GA and the default** — auto-saves state on stop. Snapshots remain available as a separate primitive for "skip dependency install on subsequent runs."
- **Timeouts**: default 5 min; max 45 min Hobby, 5 h Pro/Enterprise.
- **Cold start**: ~ms (advertised).
- **Pricing**: Active CPU $0.128/hr (billed only while CPU active), provisioned mem $0.0212/GB-hr, $0.60/M creates, $0.08/GB-mo storage. `iad1` only.
- **Execution**: `runCommand` (sync + streaming), file R/W via SDK. Runtimes: `node26`, `node24` (default), `node22`, `python3.13`; others via `dnf`. No first-class REPL. Up to 15 exposed ports → preview URLs.
- **Persistence**: 32 GB NVMe; snapshots persist across sandboxes; persistent sandboxes auto-save.
- **Egress**: advanced egress firewall via `networkPolicy.allow` — supports exact domains and wildcards (e.g. `*.github.com`).
- **Secret injection** ✓ — GA since Feb 23, 2026 (Pro/Enterprise). Firewall-layer header injection (not TLS MITM): when the sandbox makes an HTTPS request to a matching domain, the firewall adds/replaces the configured headers before forwarding. Per-host scoped via the same `networkPolicy.allow` shape:
  ```ts
  await Sandbox.create({
    networkPolicy: {
      allow: {
        "ai-gateway.vercel.sh": [
          {
            transform: [{ headers: { authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}` } }],
          },
        ],
      },
    },
  })
  ```
  Sources: [changelog 2026-02-23](https://vercel.com/changelog/safely-inject-credentials-in-http-headers-with-vercel-sandbox).
- **Images**: fixed AL2023 base, runtime install only (sudo OK).
- **Auth**: OIDC (default on Vercel; `vercel link` + `vercel env pull` for local dev) or access token.
- **TS SDK**: yes, first-class.

### Cloudflare Sandbox SDK — `@cloudflare/sandbox`

Verified against [developers.cloudflare.com/sandbox](https://developers.cloudflare.com/sandbox/) and [the proxy-requests guide](https://developers.cloudflare.com/sandbox/guides/proxy-requests/).

- **Primitive**: Container (Cloudflare's container runtime), backed by a Durable Object.
- **Lifecycle**: `getSandbox(env.Sandbox, "user-123")` → `.exec()`, `.mkdir()`, `.writeFile()`, `.readFile()`, `.watch()`, `.terminal()`, `.wsConnect()`; idle stop via `sleepAfter`. State tied to a DO.
- **Cold start**: container boot (seconds cold, warm fast).
- **Pricing**: Cloudflare Containers billing (CPU-ms + GB-s + requests); needs Workers Paid.
- **Execution**: `.exec()`, `.createCodeContext()` + `.runCode()` for the **Code Interpreter API** (persistent Python/JS contexts with auto-parsed rich output). Browser terminal via `.terminal()` / `.wsConnect()`. Preview URLs for exposed ports. R2/S3/GCS bucket mounting.
- **Persistence**: container FS lives while DO is alive; can mount object storage. No memory snapshot/fork.
- **Egress**: programmable via outbound Worker proxy — `createProxyHandler` mounts handlers at `/proxy/<service-name>/*` paths.
- **Secret injection**: yes — `createProxyToken` issues a signed JWT per sandbox (the JWT carries `sandboxId`); `ServiceConfig.transform(ctx)` injects the real credential before forwarding (`ctx.env` + `ctx.jwt`). "Real credentials never enter the sandbox." Most flexible model in the lineup — arbitrary JS at the proxy layer.
- **Images**: Dockerfile supported via Containers; runtime install OK.
- **TS SDK**: yes, designed for Workers context.

### E2B — `e2b`

- **Primitive**: Firecracker microVM.
- **Lifecycle**: `Sandbox.create()` → `commands.run()` / `files.*` → `kill()`. **`pause()` / `resume()` is first-class** — captures FS+memory+processes, resume in ~1 s, billing stops while paused.
- **Timeouts**: configurable; max 1 h Base / 24 h Pro. `setTimeout()` extends live.
- **Cold start**: ~150–300 ms; resume ~1 s.
- **Pricing**: per-second of running sandbox; free $100 credit, Pro $150/mo, BYOC/self-host enterprise.
- **Execution**: shell exec with streaming, file R/W, upload/download. Python + Node first-class. **Jupyter-style stateful sessions** flagship. Background processes, public preview URLs.
- **Persistence**: pause/resume preserves memory state; custom templates serve as snapshots; fork via creating from paused snapshot.
- **Egress**: `egressTransform` + domain rules (TLS MITM, per-sandbox CA).
- **Secret injection**: yes — TLS MITM injects headers per domain. One of the three providers with real proxy-layer secret rewriting.
- **Images**: custom templates via `e2b template build` (Dockerfile-like); many pre-built (code-interpreter, desktop).
- **TS SDK**: yes, first-class.

### Modal — `modal` (libmodal for JS, beta)

- **Primitive**: `modal.Sandbox`, containerized, gVisor isolation.
- **Lifecycle**: `modal.Sandbox.create(...)` → `.exec()` → `.wait()` / `.terminate()`. 5-state machine; `Sandbox.from_name()` reattach. **Filesystem snapshots**.
- **Timeouts**: default 5 min, configurable up to 24 h.
- **Pricing**: per-CPU-second + GPU + memory.
- **Execution**: `sb.exec()` with streaming. Any language in the image. Per-sandbox multi-process tracking. Tunnels API for public HTTP/2 URLs.
- **Persistence**: `modal.Volume` named persistent storage; FS snapshots cross-24h.
- **Egress**: `block_network=True`, `cidr_allowlist` (**CIDR only — IP/range, not hostname**). Sandbox Connect Tokens for authenticated _inbound_ HTTP.
- **Secret injection**: no — env vars only, no HTTPS MITM rewrite.
- **Images**: `modal.Image` (Debian slim, pip/apt, registry refs, full Dockerfile).
- **TS SDK**: yes, **beta** (libmodal JS+Go). Python is primary.

### Daytona — `@daytona/sdk`

Verified against [Daytona TypeScript SDK docs v0.177](https://www.daytona.io/docs/typescript-sdk/sandbox/).

- **Primitive**: "Sandbox" exposing `fs`, `process`, and git integration; dedicated kernel + FS + network stack.
- **Lifecycle**: create → `process.executeCommand()` / `process.codeRun()` → stop/destroy. Snapshot + fork are **experimental** (`_experimental_createSnapshot()`, `_experimental_fork()`) — flag as unstable.
- **Cold start**: marketed "<90 ms" (separate marketing page).
- **Pricing**: not transparently public.
- **Execution**: shell exec via `process.executeCommand`, code execution via `process.codeRun` (any language). `CodeInterpreter` is **Python-only** — multi-language goes through `process.codeRun`. Preview proxy for ports.
- **Persistence**: `volumes?: SandboxVolume[]` field on create; experimental snapshots.
- **Egress**: `networkAllowList?: string` (CIDR format) and `networkBlockAll: boolean` — **CIDR only, no hostname support**.
- **Secret injection**: no.
- **Images**: OCI/Docker compatible.
- **TS SDK**: yes, first-class.
- **Notable**: ships `ComputerUse` interface, `toolboxProxyUrl`, MCP server (separate). Most "agent-OS" framing.

### CodeSandbox SDK — `@codesandbox/sdk`

- **Primitive**: Firecracker microVM.
- **Lifecycle**: create → run → **hibernate / resume / fork**. Memory snapshot + fork is the headline.
- **Cold start**: 3–10 s create, 0.5–2 s resume, ~0.5 s fork.
- **Pricing**: per-minute VM credits at $0.01486/credit, 1-min increments.
- **Execution**: shell exec, FS, file watch. Background processes, preview URLs.
- **Persistence**: per-sandbox disk + memory state via hibernate; **forking clones full state in seconds** — closest thing to "git branch for VMs."
- **Egress**: no documented user-configurable allowlist.
- **Secret injection**: no.
- **Images**: any Dockerfile.
- **TS SDK**: yes.

### Runloop — `@runloop/api-client`

- **Primitive**: "Devbox" — isolated Linux sandbox (VM).
- **Lifecycle**: create → initializing → active → suspend/snapshot/shutdown. `launch_commands` runs at boot. PTY sessions over WebSocket with reconnect-by-name.
- **Pricing**: enterprise / not transparent.
- **Execution**: `exec` + `execAsync`, file ops, repo mounts, storage objects with presigned URLs. **PTY session API** (best terminal/REPL UX in the list). Tunnels for public HTTPS. SSH.
- **Persistence**: snapshots, mounts, storage objects.
- **Egress**: Network Policies.
- **Secret injection**: **yes — Agent Gateway** is an L7 proxy that substitutes auth at the infra layer (agent gets a short-lived gateway token, never the real key). MCP Hub does the same for MCP servers.
- **Images**: Blueprints (Dockerfile-like).
- **TS SDK**: yes.
- **Notable**: most explicitly agent-focused product.

### Microsandbox (local) — `microsandbox`

Verified against [docs.microsandbox.dev/getting-started/introduction](https://docs.microsandbox.dev/getting-started/introduction).

- **Primitive**: microVM (specific tech like libkrun not disclosed in the public docs).
- **Lifecycle**: **no daemon** — the runtime spawns directly as a child process of whatever application creates the sandbox. Library API; snapshot/fork ("capture a stopped sandbox's writable upper layer as a portable artifact, then boot fresh sandboxes from it").
- **Cold start**: **under 100 ms** per the docs.
- **Platforms**: macOS (Apple Silicon) + Linux (KVM). **No Windows** in the current docs (revise if a later release adds it).
- **License**: not stated on this page.
- **Execution**: shell exec, FS, scripts, process mgmt, port forwarding.
- **Persistence**: OCI image reuse, snapshots, host-dir mounts + managed volumes.
- **Egress (general allowlist)**: **roadmap — "coming soon"** in the docs (`allowlist(["api.openai.com"])`-style API). Not yet shipped. **Implication for the abstraction: do NOT ship the `SandboxHostnameAllowlist` marker for Microsandbox in Phase 1.** Re-check at implementation time.
- **Secret injection** ✓ shipped: `.secret_env()` API with per-secret `.allow_host()` restriction — placeholders inside the guest swap for real values at the network boundary. "The guest never has the secret at all." This is the _secret-scoped_ network gate, distinct from a general egress allowlist.
- **Images**: any OCI image (Docker Hub, GHCR, ECR, GCR).
- **TS SDK**: yes — `microsandbox` on npm.
- **Notable**: ships an MCP server per the project landing page (not mentioned on the introduction page; re-verify against the MCP docs section).

### BoxLite (local) — `@boxlite-ai/boxlite`

- **Primitive**: microVM (`SimpleBox`).
- **Lifecycle**: embeddable Rust runtime (no separate daemon); async context manager.
- **Cold start**: "sub-second" (exact ms not published).
- **Platforms**: macOS ARM64 (HVF), Linux x86_64/ARM64 (KVM). **No Windows.**
- **License**: Apache 2.0.
- **Execution**: shell exec, full Linux env, port forwarding, DNS, full internet by default.
- **Persistence**: QCOW2 persistent disks, volume mounts, OCI image caching, snapshots.
- **Egress**: allowlists documented in marketing copy.
- **Secret injection**: unknown / not advertised.
- **Images**: OCI compatible.
- **TS SDK**: yes (npm `@boxlite-ai/boxlite`).

### Anthropic Sandbox Runtime (local) — `@anthropic-ai/sandbox-runtime`

- **Primitive**: process-level sandbox (bubblewrap on Linux, sandbox-exec on macOS).
- **Lifecycle**: wrap a process; not "exec into" a long-lived sandbox.
- **Cold start**: <20 ms (no daemon, no VM).
- **Platforms**: macOS + Linux.
- **Execution**: any host command; HTTP/SOCKS5 proxy for domain-based egress filtering.
- **Persistence**: bind mounts to host FS.
- **Egress**: hostname allowlist via on-host proxy.
- **Secret injection**: no.
- **Images**: none — runs against host FS with bind mounts.
- **TS SDK**: yes (npm CLI wrapper). Used by Claude Code's `/sandbox`.
- **Notable**: **shared kernel** — explicitly weaker isolation than microVMs. Worth shipping as a "process sandbox" provider for offline / hermetic local use where users accept the trade-off.

### Docker — via `dockerode` (local)

- **Primitive**: container (or microVM-wrapped container if using Docker Sandboxes, March 2026).
- **Lifecycle**: create → start → exec → kill → rm; pause/resume; `docker commit` snapshots.
- **Cold start**: 0.5–2 s.
- **Platforms**: Linux native; macOS/Windows via Docker Desktop.
- **Execution**: exec with streaming, full FS, scripts, processes, port publish.
- **Persistence**: bind mounts + named volumes + image layers + commits.
- **Egress**: no native hostname allowlist (bolt on a proxy).
- **Secret injection**: no.
- **Images**: OCI.
- **TS SDK**: yes (`dockerode`).
- **Notable**: **plain Docker shares the host kernel — not safe for untrusted model code on its own**. Document this. gVisor (`runsc`) as a runtime is a stronger story; expose as a `runtime: "runc" | "runsc"` flag on the Docker provider.

### Deno Sandbox — `@deno/sandbox`

Launched February 3, 2026 alongside Deno Deploy GA. Deno's **purpose-built** product for running LLM-generated code (not to be confused with Deno Subhosting, which remains a separate "multi-tenant ship-and-invoke" SaaS platform). One of the cleanest API shapes in the entire landscape — and it's already designed around explicit resource management, which maps directly to our Effect.Scope design.

- **Primitive**: Firecracker microVM (same tech as AWS Lambda, E2B, Vercel Sandbox, Microsandbox).
- **Lifecycle**: `Sandbox.create(opts)` → `await using` resource — auto-disposed on scope exit. Boots in **under 1 s**.
- **Timeouts**: max **30 min** lifetime per sandbox.
- **Resources**: 2 vCPU, 768 MB – 4 GB RAM (1.2 GB default), 10 GB ephemeral disk.
- **Concurrency**: 5 sandboxes / org during pre-release; increases planned.
- **Regions**: `ams` (Amsterdam), `ord` (Chicago).
- **Execution**: `sandbox.sh\`...\``template-literal shell exec;`spawn(...)` (Python SDK shape; expected on JS SDK) for long-running processes. Full Linux environment — files, processes, package managers.
- **Persistence**: **Volumes** (read-write, for caches/databases/user data) + **Snapshots** (read-only pre-installed images for fast cold starts).
- **Egress**: hostname allowlist via `allowNet: ["api.openai.com", "*.anthropic.com"]` — implemented as an outbound proxy at the VM boundary.
- **Secret injection** ✓ — first-class, the cleanest API of any provider:
  ```ts
  await using sandbox = await Sandbox.create({
    allowNet: ["api.openai.com"],
    secrets: {
      OPENAI_API_KEY: { hosts: ["api.openai.com"], value: process.env.OPENAI_API_KEY },
    },
  })
  ```
  Placeholder in the env; real value materializes only on outbound to listed host. Exfiltrated placeholders are inert.
- **`sandbox.deploy()`**: graduate a sandbox to a production Deno Deploy deployment. Useful for "agent prototypes a service, then ships it" workflows. We expose it through the per-provider narrowed request, not the common interface.
- **Images**: not user-customizable (no Dockerfile). Snapshots fill the "pre-installed dependencies" role.
- **Auth**: Deno Deploy API token.
- **TS SDK**: yes — `@deno/sandbox` (JSR + npm). Python SDK at `deno-sandbox` (PyPI).
- **Pricing**: not yet finalized at GA; pre-release pricing TBD.
- **Notable**: the SDK already uses TC39's **`await using`** for explicit resource management. The lifetime model is identical to our `Effect.Scope`-based design — wiring is mechanical.

Sources: [docs.deno.com/sandbox](https://docs.deno.com/sandbox/), [Introducing Deno Sandbox](https://deno.com/blog/introducing-deno-sandbox).

### Other providers (briefly considered, not in initial pass)

- **Google Gemini code-execution tool** — hosted model tool; expose via the Gemini adapter, not the sandbox layer.
- **OpenAI / Anthropic hosted code execution** — same: hosted tool, not a sandbox provider.
- **Gondolin** (`@earendil-works/gondolin`) — TS-first microVM control plane, experimental; track for a later local provider.
- **Firecracker raw**, **nsjail/bwrap (without srt)**, **Nix sandbox** — infrastructure used by the providers above; not direct targets.
- **Pyodide, WebContainers, isolated-vm** — different runtimes / different consumers; out of scope for the first pass.

---

## Cross-provider capability matrix

P1 providers (priority) bolded in the header.

| Capability                    | **Vercel**          | **Cloudflare** | **Deno**      | **Daytona** | **Microsandbox** | E2B            | Modal     | CodeSandbox | Runloop    | BoxLite   | Anthropic srt | Docker      |
| ----------------------------- | ------------------- | -------------- | ------------- | ----------- | ---------------- | -------------- | --------- | ----------- | ---------- | --------- | ------------- | ----------- |
| Shell exec + streaming        | ✓                   | ✓              | ✓             | ✓           | ✓                | ✓              | ✓         | ✓           | ✓          | ✓         | ✓             | ✓           |
| File R/W via SDK              | ✓                   | ✓              | ✓             | ✓           | ✓                | ✓              | ✓         | ✓           | ✓          | ✓         | host bind     | ✓           |
| Expose port → public URL      | ✓                   | ✓              | ✓             | ✓           | local fwd        | ✓              | ✓         | ✓           | ✓          | local fwd | —             | local pub   |
| **Snapshot / fork**           | ✓ snap              | DO state       | ✓ (read-only) | exp.¹       | ✓ snap/fork      | ✓ pause/resume | ✓ fs-snap | ✓ **fork**  | ✓ snap     | ✓ snap    | —             | `commit`    |
| **Persistent volumes**        | beta                | DO storage     | ✓             | ✓           | ✓                | template       | ✓ Volume  | per-sandbox | mounts     | ✓         | host bind     | ✓           |
| **Egress hostname allowlist** | ✓ domains+wildcards | ✓ programmable | ✓ `allowNet`  | CIDR only   | soon²            | ✓              | CIDR only | —           | ✓ policies | ✓         | ✓ proxy       | — (bolt-on) |
| **Proxy secret injection**    | ✓ header xform      | ✓ JWT          | ✓             | —           | ✓ secret-scoped  | ✓              | —         | —           | ✓ Gateway  | unknown   | —             | —           |

¹ Daytona snapshot/fork is exposed as `_experimental_*` in the TS SDK — treat as unstable.
² Microsandbox: per-secret `.allow_host()` is shipped, but the general `allowlist([...])` egress API is marked "coming soon" in the docs. Don't ship `SandboxHostnameAllowlist` for Microsandbox in Phase 1; secret injection works regardless.
| Custom images | — (fixed) | ✓ | — (snapshots only) | ✓ | ✓ | ✓ template | ✓ | ✓ Dockerfile | ✓ Blueprint | ✓ OCI | — | ✓ |
| Stateful REPL / kernel | — | ✓ Code Interp | — | partial | — | ✓ Jupyter | — | — | PTY | — | — | — |
| PTY session | — | term API | — | — | — | — | — | — | ✓ WS | — | — | exec -it |

Where providers diverge most (the design decisions the abstraction has to make):

1. **Snapshot semantics.** Eight providers support some form of snapshot, but the shape varies dramatically — E2B/CodeSandbox have memory+disk pause/resume; Modal/Vercel have FS-only; Runloop/Daytona/Microsandbox/BoxLite snapshot then restore as a _new_ sandbox. We can't unify into one verb without lying.
2. **Egress policy fidelity.** SNI/hostname (Vercel, E2B, Microsandbox, Cloudflare, Runloop) vs CIDR-only (Modal, Daytona) vs none-without-bolt-on (CodeSandbox, plain Docker). A `allowedHosts: string[]` field silently truncated to CIDRs is worse than refusing.
3. **Proxy-layer secret injection.** This is the single highest-value security feature for agent code-exec (LLM never sees the real key), and only 4–5 providers do it: E2B, Cloudflare, Runloop Agent Gateway, Microsandbox, and (claimed) Vercel. Treat it as a first-class capability marker — not a parameter on a generic method.
4. **REPL vs exec.** Cloudflare Code Interpreter and E2B Jupyter sessions are persistent Python/JS kernels with rich output (charts, tables). Everyone else expects you to `python script.py` from `exec`. Different shape, different return type, gate behind a capability.
5. **Custom images.** Vercel's fixed AL2023 base means callers depending on `image: "python:3.12"` fail at decode-time if Vercel is the wired layer. Either expose `image` as a typed-narrowed field per provider, or accept that calls fail at decode for some.
6. **Local-vs-cloud surface gap.** Local providers can't durably persist sandbox state across machines; cloud providers can't run offline. The abstraction should not pretend these are interchangeable when the user's use case actually depends on it.

---

## Prior art

Three useful reference points; all have weaknesses we want to avoid.

- **Vercel AI SDK 6** ships a "Code Execution Tool" plus a `Manifest` abstraction for workspaces, with built-in BYO sandbox (Blaxel, Cloudflare, Daytona, E2B, Modal, Runloop, Vercel). Declarative manifest above imperative API — interesting but heavier than what we want.
- **ComputeSDK** (`computesdk/computesdk`) is the closest existing cross-provider abstraction: `compute.sandbox.create()` → `runCommand`, `filesystem.{readFile,writeFile,mkdir,…}`, `destroy`. Provider-specific knobs aren't unified; unsupported features silently no-op. We want **typed capabilities** instead of silent drops.
- **AutoGen `CodeExecutor`** (`LocalCommandLineCodeExecutor` vs `DockerCommandLineCodeExecutor`) is the cleanest minimal interface: `execute_code_blocks(blocks) → CodeResult`. Treat code as the unit. Useful framing for the REPL-style capability.
- **LangChain / LlamaIndex / CrewAI** all collapse code execution into "a tool that takes a `code: string`." Loses everything interesting (snapshot, egress, secrets, sessions). We need a real service, not a tool.
- **OpenAI Agents SDK / Anthropic Managed Agents** delegate the sandbox to BYO providers (Cloudflare, Daytona, Modal, Vercel) rather than abstract — implicitly endorsing the multi-provider model.

---

## Abstraction design

### Effect-native shape

The whole point of building this on Effect is that **a sandbox is a textbook acquire-release resource**: provision is fallible, the live handle holds state, and you must always release it (otherwise you burn credits / leak microVMs). So the primary `create` returns a **scoped** Effect — `destroy` is the resource finalizer, not a method you remember to call. Methods on the handle are plain `Effect` / `Stream` values, no nullary thunks.

```ts
// Service definition
export type SandboxService = {
  /**
   * Acquire a sandbox scoped to the calling Effect. Finalizer runs `destroy` on
   * scope close. Use `Sandbox.attach` for sandboxes that should outlive the
   * scope (paused, persistent, or shared across runs).
   */
  readonly create: (
    request: CommonCreateRequest,
  ) => Effect.Effect<SandboxInstance, AiError, Scope.Scope>

  /**
   * Re-acquire a previously created sandbox by id. Same scoped semantics —
   * finalizer detaches the handle without destroying the remote sandbox.
   * Capability-gated on providers that don't expose a stable id.
   */
  readonly attach: (id: SandboxId) => Effect.Effect<SandboxInstance, AiError, Scope.Scope>

  /**
   * List existing sandboxes for the configured account. Provider-gated.
   */
  readonly list: Effect.Effect<ReadonlyArray<SandboxRef>, AiError>
}

export class Sandbox extends Context.Service<Sandbox, SandboxService>()(
  "@betalyra/effect-uai/Sandbox",
) {}

// Handle returned from create / attach
export type SandboxInstance = {
  readonly id: SandboxId

  readonly exec: (request: CommonExecRequest) => Effect.Effect<ExecResult, AiError>
  readonly execStream: (request: CommonExecRequest) => Stream.Stream<ExecEvent, AiError>

  /** Background / long-running. Returns a scoped handle; killing it on scope close. */
  readonly spawn: (request: CommonExecRequest) => Effect.Effect<ProcessHandle, AiError, Scope.Scope>

  readonly files: {
    readonly read: (path: string) => Effect.Effect<Uint8Array, AiError>
    readonly write: (path: string, contents: Uint8Array | string) => Effect.Effect<void, AiError>
    readonly remove: (path: string) => Effect.Effect<void, AiError>
    readonly mkdir: (path: string) => Effect.Effect<void, AiError>
    readonly list: (path: string) => Effect.Effect<ReadonlyArray<FileEntry>, AiError>
  }

  /** Expose an internal port → public URL. Effect, not nullary thunk. */
  readonly exposePort: (port: number) => Effect.Effect<{ readonly url: string }, AiError>
}

export type ProcessHandle = {
  readonly pid: number
  readonly events: Stream.Stream<ExecEvent, AiError>
  readonly kill: Effect.Effect<void, AiError>
  readonly exit: Effect.Effect<{ readonly exitCode: number }, AiError>
}
```

#### Usage shape

```ts
// Default case — sandbox auto-destroyed when this Effect completes
const result = Effect.gen(function* () {
  const sandbox = yield* Sandbox.create({ image: "python:3.12" })
  yield* sandbox.files.write("/tmp/script.py", "print(2+2)")
  return yield* sandbox.exec({ cmd: ["python", "/tmp/script.py"] })
}).pipe(Effect.scoped)

// Long-lived sandbox shared across many turns — manage the Scope yourself
Effect.gen(function* () {
  const scope = yield* Scope.make()
  const sandbox = yield* Effect.provideService(
    Sandbox.create({ image: "python:3.12" }),
    Scope.Scope,
    scope,
  )
  // ... use sandbox across many independent agent turns ...
  yield* Scope.close(scope, Exit.void)
})
```

`Effect.scoped` is the bouncer: if a caller forgets to scope, TypeScript won't let them run the program. That's the property we want — losing money to forgotten microVMs is the biggest foot-gun on this kind of API.

#### What we deliberately do NOT do

- **No `destroy()` method on the instance.** It's the scope finalizer. Manually destroying mid-scope is allowed only via the escape hatch `Sandbox.destroy(id)` at the service level, for the rare "I need to nuke this from another fiber" case.
- **No nullary thunks** (`pause()`, `kill()`). They become plain `Effect` values: `sandbox.pause`, `processHandle.kill`. Matches the `Queue.shutdown` / `Fiber.interrupt` style in Effect itself.
- **No imperative `Promise`-returning methods.** Every method returns `Effect` or `Stream`.

### Capability markers

Same pattern as `TtsIncrementalText` / `MultiSpeakerTts` in [SpeechSynthesizer.ts](packages/core/src/speech-synthesizer/SpeechSynthesizer.ts) — phantom `Context.Service<…, void>` classes the provider Layer either ships or doesn't. Compile error at `Effect.provide` if the wired provider can't satisfy a capability the consumer needs.

```ts
export class SandboxPauseResume    // in-place pause/resume (E2B, CodeSandbox)
export class SandboxSnapshots      // snapshot → SnapshotId, restore as a new sandbox
export class SandboxKernelSession  // Jupyter-style stateful REPL (Cloudflare CI, E2B kernel)
export class SandboxPty            // interactive PTY (Runloop, Cloudflare terminal)
export class SandboxHostnameAllowlist  // egress allowlist accepts hostnames (not just CIDRs)
export class SandboxSecretInjection    // proxy-layer secret rewriting at TLS edge
export class SandboxVolumes        // named persistent volumes detached from sandbox lifecycle
export class SandboxCustomImage    // accept Dockerfile / OCI ref
```

Free helpers (matching `streamSynthesisFrom`):

```ts
// Available on every Sandbox layer
export const create = (req: CommonCreateRequest):
  Effect.Effect<SandboxInstance, AiError, Sandbox | Scope.Scope> => …

// Only on providers that ship the marker — caller's R picks them up
export const pause = (s: SandboxInstance):
  Effect.Effect<void, AiError, SandboxPauseResume> => …

export const snapshot = (s: SandboxInstance, name: string):
  Effect.Effect<SnapshotId, AiError, SandboxSnapshots> => …

export const runCode = (s: SandboxInstance, code: string, lang: "python" | "javascript"):
  Effect.Effect<KernelResult, AiError, SandboxKernelSession> => …
```

### Snapshots, volumes, images — independent of any sandbox

Per (4): these resources outlive any single sandbox. Most providers model snapshots as a special image anyway (E2B templates from paused state, CodeSandbox memory snapshots, Modal/Vercel/Daytona snapshots-as-images, Microsandbox OCI-shaped snapshots). So we collapse "image" and "snapshot" into one concept — `ImageRef` — with two constructors:

```ts
export type ImageRef =
  | { readonly _tag: "registry"; readonly ref: string }                  // e.g. "python:3.12", "ghcr.io/org/foo:tag"
  | { readonly _tag: "snapshot"; readonly id: SnapshotId }               // captured state
  | { readonly _tag: "default" }                                          // provider's default base
  | { readonly _tag: "dockerfile"; readonly contents: string }            // capability-gated: SandboxCustomImage

// Snapshot lifecycle lives on the service, NOT on the instance
export type SandboxService = {
  …existing fields…
  readonly snapshots: {
    readonly create: (from: SandboxInstance, name?: string) => Effect.Effect<SnapshotId, AiError>
    readonly destroy: (id: SnapshotId) => Effect.Effect<void, AiError>
    readonly list: Effect.Effect<ReadonlyArray<{ id: SnapshotId; name?: string }>, AiError>
  }
  readonly volumes: {
    readonly create: (name: string) => Effect.Effect<VolumeId, AiError>
    readonly destroy: (id: VolumeId) => Effect.Effect<void, AiError>
    readonly list: Effect.Effect<ReadonlyArray<{ id: VolumeId; name: string }>, AiError>
  }
}
```

`snapshots` and `volumes` sub-services are themselves gated by `SandboxSnapshots` / `SandboxVolumes` markers — if the provider doesn't support them, the layer doesn't ship the marker, and any call to a snapshot/volume helper is a compile error.

### `CommonCreateRequest`

```ts
export type CommonCreateRequest = {
  /** Image / snapshot to boot from. Provider-narrowed (Vercel ignores `_tag: "dockerfile"`, rejects at decode). */
  readonly image?: ImageRef

  /** Idle / hard timeout. Providers default differently; pass explicitly to avoid surprises. */
  readonly timeoutMs?: number

  /** Env vars exposed to the sandbox. NOT for secrets you want hidden — see `secrets`. */
  readonly env?: Readonly<Record<string, string>>

  /** Network egress policy. */
  readonly network?: NetworkPolicy

  /** Bound secrets — code inside the sandbox never sees the value; proxy injects on outbound to `hosts`. */
  readonly secrets?: ReadonlyArray<BoundSecret>

  /** Persistent volumes to mount. */
  readonly volumes?: ReadonlyArray<{ readonly id: VolumeId; readonly mountPath: string }>
}

export type NetworkPolicy =
  | { readonly _tag: "open" }
  | { readonly _tag: "blocked" }
  | {
      readonly _tag: "allowlist"
      readonly hosts?: ReadonlyArray<string>
      readonly cidrs?: ReadonlyArray<string>
    }

export type BoundSecret = {
  readonly name: string // placeholder visible inside sandbox (e.g. "OPENAI_API_KEY")
  readonly value: Redacted.Redacted<string> // real value, never enters the sandbox
  readonly hosts: ReadonlyArray<string> // host patterns where injection is allowed
  readonly header?: string // default: "Authorization: Bearer <value>"
}
```

### `CommonExecRequest`

```ts
export type CommonExecRequest = {
  readonly cmd: string | ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: string | Uint8Array
  readonly timeoutMs?: number
}

export type ExecResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

export type ExecEvent =
  | { readonly _tag: "stdout"; readonly chunk: Uint8Array }
  | { readonly _tag: "stderr"; readonly chunk: Uint8Array }
  | { readonly _tag: "complete"; readonly exitCode: number; readonly durationMs: number }
```

Background processes go through `spawn`, which returns a `ProcessHandle` in `Scope.Scope` — the process is killed on scope close. No `detached` flag on `exec`.

### Two snapshot capabilities, not one

`SandboxPauseResume` (in-place, same instance survives — E2B, CodeSandbox) and `SandboxSnapshots` (capture-then-restore-as-new — Modal, Vercel, Daytona, Microsandbox, Runloop) are intentionally separate. They have incompatible semantics — pause/resume preserves the live id, snapshots produce a derived `ImageRef`. Providers ship whichever they actually do.

### Error model

Reuse `AiError` patterns from the existing services:

- `SandboxCreateFailed` — provisioning failed
- `SandboxNotFound` — id missing
- `SandboxTimeout` — wall-clock or idle exceeded
- `SandboxExecFailed` — generic exec failure (distinct from non-zero exit, which is `ExecResult`)
- `SandboxNetworkPolicyDenied` — call blocked by egress policy
- `Unsupported` — feature not available on the wired provider (reuse existing AiError)
- `SandboxQuotaExceeded` — provider-side quota / concurrency

### Decode-time vs runtime errors

Following the existing pattern: pass the request through a `Schema.Struct` narrowed per provider. Provider-specific fields (`region`, `template`, `cpu`, `memory`, custom-image fields) are typed and validated at decode. Cross-provider fields that the wired provider doesn't support (e.g. hostname allowlist passed to Modal, image passed to Vercel) **fail at decode**, not silently at runtime. This is the ComputeSDK-anti-pattern we want to avoid.

### Why capability markers, not a single mega-interface

Because the consumer code is then _typed_ — `sandbox.snapshot()` only compiles if `SandboxSnapshots` is in the environment. The user picks providers based on the capabilities their code requires; mismatches are a compile error, not a 3 AM `UnsupportedError`. This is exactly the trick used by `TtsIncrementalText` and `MultiSpeakerTts` in [SpeechSynthesizer.ts](packages/core/src/speech-synthesizer/SpeechSynthesizer.ts).

---

## Package layout

Following the existing convention — one package per **provider** (vendor), each containing all the services that vendor offers. Just like `@effect-uai/openai` contains `OpenAISynthesizer`, `OpenAITranscriber`, `OpenAIRealtimeTranscriber`, the sandbox lives inside its vendor's package as `VercelSandbox.ts`, `E2BSandbox.ts`, etc.

```
packages/
  core/src/sandbox/
    Sandbox.ts                — service definition + capability markers + free helpers
    Sandbox.test.ts

  providers/
    vercel/         src/VercelSandbox.ts          — @effect-uai/vercel       (new package)
    cloudflare/     src/CloudflareSandbox.ts      — @effect-uai/cloudflare   (new package)
    e2b/            src/E2BSandbox.ts             — @effect-uai/e2b          (new package)
    modal/          src/ModalSandbox.ts           — @effect-uai/modal        (new package)
    daytona/        src/DaytonaSandbox.ts         — @effect-uai/daytona      (new package)
    codesandbox/    src/CodeSandboxSandbox.ts     — @effect-uai/codesandbox  (new package)
    runloop/        src/RunloopSandbox.ts         — @effect-uai/runloop      (new package)
    microsandbox/   src/MicrosandboxSandbox.ts    — @effect-uai/microsandbox (new package)
    boxlite/        src/BoxLiteSandbox.ts         — @effect-uai/boxlite      (new package)
    anthropic/      src/AnthropicSandboxRuntime.ts — extend existing @effect-uai/anthropic
    docker/         src/DockerSandbox.ts          — @effect-uai/docker       (new package)
```

Each `*Sandbox.ts` file exports:

- a narrowed `<Provider>SandboxService` type (extending `SandboxService` with provider-specific request fields typed)
- a `<Provider>Sandbox` `Context.Service`
- a `layer(config)` builder that provides `Sandbox` + whichever capability markers the provider satisfies

Provider-specific MCP-server bindings, when we get to them, also live in the same package (e.g. `packages/providers/e2b/src/E2BMCPServer.ts`) — but that's a separate workstream.

---

## Decisions & deferred items

Resolved in design review (2026-05-21):

1. **Streaming output unit** → `Uint8Array` chunks (matches `AudioChunk` precedent). Ship a line-oriented helper later if needed; don't bake it into the wire shape.
2. **Working directory & user identity** → expose `cwd` on `CommonExecRequest`; the `user` field is **provider-specific** (lives on the narrowed per-provider request, not the common shape). Document the default per provider — don't pretend it's portable.
3. **Long-running processes** → `sandbox.spawn(req)` returns a scoped `ProcessHandle`. No `detached` flag on `exec`. Killed on scope close (or explicitly via `processHandle.kill`).
4. **Snapshots, volumes, images** → independent of any individual `SandboxInstance`. Snapshots are modeled as a special `ImageRef` (the `{ _tag: "snapshot"; id }` constructor). `Sandbox.snapshots.{create,destroy,list}` and `Sandbox.volumes.{create,destroy,list}` live on the service, gated by their respective capability markers.
5. **Cost telemetry** → expose only if it unifies into a simple shape. Open question; investigate during Phase 1 implementation when wiring E2B + Vercel (both report active-CPU billing). If it doesn't fit cleanly, defer.

Deferred:

6. **MCP server bindings** — handled separately; will live inside the same provider package (e.g. `packages/providers/e2b/src/E2BMCPServer.ts`) when we get to it. Not bundled with the initial sandbox work.
7. **Computer-use / VNC** — out of scope.

---

## Suggested phasing

The five **P1 providers** were chosen to cover the full capability surface with as little overlap as possible: two cloud microVMs that share the secret-injection winners' bracket (**Deno**, **Cloudflare**), one cloud microVM without secret-injection but with the cleanest egress firewall and persistent-sandboxes story (**Vercel**), one agent-OS-flavoured cloud (**Daytona**) for the experimental snapshot/fork + computer-use surface, and one local microVM (**Microsandbox**) for the offline / on-prem / zero-latency case.

### Phase 1 — core + 5 P1 providers

Ship `packages/core/src/sandbox/Sandbox.ts` with:

- The minimal interface — `create` (scoped), `attach`, `list`; instance methods `exec`, `execStream`, `spawn`, `files.*`, `exposePort`.
- Capability markers needed by P1 — `SandboxHostnameAllowlist`, `SandboxSecretInjection`, `SandboxSnapshots`, `SandboxVolumes`, `SandboxKernelSession`.

Wire all five P1 layers:

| Provider           | Package                          | Capability markers shipped                                                                                              |
| ------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Deno Sandbox       | `@effect-uai/deno` (new)         | Allowlist + SecretInjection + Snapshots + Volumes                                                                       |
| Cloudflare Sandbox | `@effect-uai/cloudflare` (new)   | Allowlist + SecretInjection + KernelSession                                                                             |
| Vercel Sandbox     | `@effect-uai/vercel` (new)       | Allowlist + SecretInjection + Snapshots                                                                                 |
| Daytona            | `@effect-uai/daytona` (new)      | Volumes (Snapshots gated behind an `experimental` flag until GA)                                                        |
| Microsandbox       | `@effect-uai/microsandbox` (new) | SecretInjection + Snapshots + Volumes (NOT Allowlist — general egress allowlist is roadmap; re-check at implementation) |

Validate the abstraction by writing **one recipe** that runs identical code (call a model-authored Python script, inject `OPENAI_API_KEY` for outbound to `api.openai.com` only, return result) against all five P1 providers from the same consumer code — with only the Layer differing.

### Phase 2 (deferred)

E2B (pause/resume + Jupyter sessions — strongest capability coverage outside P1), Modal (volumes + gVisor), CodeSandbox (memory fork), Runloop (Agent Gateway, MCP Hub). Add `SandboxPauseResume`, `SandboxPty`.

### Phase 3 (deferred)

Local + escape hatches. Anthropic srt (extends the existing `@effect-uai/anthropic`), Docker via `dockerode`, BoxLite. Add `SandboxCustomImage`.

### Phase 4 (deferred)

Per-provider MCP-server bindings inside the respective vendor packages. Decided in a separate workstream.

Each phase adds one capability marker at most — same cadence we used rolling out `MultiSpeakerTts` and `TtsIncrementalText`.
