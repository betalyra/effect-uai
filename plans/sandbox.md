# Sandbox Provider Landscape — Code Execution

Planning doc for adding a code-execution **Sandbox** provider abstraction to `effect-uai`, mirroring the existing `LanguageModel` / `SpeechSynthesizer` / `Transcriber` services.

Compiled 2026-05-21. Pricing, model/template names, and SDK shapes change quickly — always re-verify against the linked source before relying.

## Why this exists

Modern LLM agents routinely need to execute model-authored code, run shell commands, install packages, snapshot state across turns, and call external APIs from inside the sandbox. The provider landscape has crystallized — the major cloud labs (Vercel, Cloudflare, Modal, E2B, Daytona, CodeSandbox, Runloop) each ship a "create a sandbox, exec into it, read/write files, expose ports" API, plus a few local microVM options that match capability-for-capability (Microsandbox, BoxLite, Gondolin). We want one Effect-shaped service that callers can wire any of them behind.

The non-goals: we are **not** wrapping hosted model-side code interpreters (OpenAI's `code_interpreter` tool, Anthropic's `code_execution` tool, Gemini code-execution). Those are *tools the model invokes*; they belong in `@effect-uai/<provider>` as native tool-shape adapters, not in a `Sandbox` provider layer.

## Scope

**In scope**

- Long-lived programmable Linux sandboxes with shell `exec`, filesystem R/W, port exposure, and lifecycle (`create` → `destroy`).
- Capability extensions: snapshots/fork, persistent volumes, hostname-allowlist egress, proxy-layer secret injection, kernel-style REPL sessions, PTY/terminal sessions, custom images.
- Both cloud and local providers under one interface.

**Out of scope (initial pass)**

- Hosted model-side interpreters (OpenAI, Anthropic, Gemini built-in code execution).
- "Deploy code and invoke" providers like Deno Subhosting and the Gemini `code-execution` tool — different shape; route through a separate `CodeRunner` interface if needed later.
- Browser-only sandboxes (Pyodide, StackBlitz WebContainers) — different runtime, different consumers; potential future `@effect-uai/sandbox-browser` package.
- Pure JS evaluators (`isolated-vm`) — not "run untrusted Python with packages"; potential future JS-only adapter.
- Kubernetes-backed agent farms (BrowserBase, Northflank etc.) — out of scope until there's a concrete user.

---

## Provider-by-provider state

For each provider: the primitive, lifecycle, what kind of execution it offers, persistence model, security posture (egress + secret injection), image model, and TS SDK readiness.

### Vercel Sandbox — `@vercel/sandbox`

- **Primitive**: Firecracker microVM on Amazon Linux 2023.
- **Lifecycle**: `Sandbox.create()` → `runCommand()` / `writeFiles()` → `stop()`. Snapshotting + "Persistent Sandboxes" (beta) for resume.
- **Timeouts**: default 5 min; max 45 min Hobby, 5 h Pro/Enterprise.
- **Cold start**: ~ms (advertised).
- **Pricing**: Active CPU $0.128/hr (billed only while CPU active), provisioned mem $0.0212/GB-hr, $0.60/M creates, $0.08/GB-mo storage. `iad1` only.
- **Execution**: `runCommand` (sync + streaming), file R/W via SDK. Runtimes: node22/24/26, python3.13; others via `dnf`. No first-class REPL. Up to 15 exposed ports → preview URLs.
- **Persistence**: 32 GB NVMe; snapshots persist across sandboxes; persistent-sandboxes beta auto-saves.
- **Egress**: SNI filtering + CIDR via `updateNetworkPolicy` (advanced egress firewall).
- **Secret injection**: yes — credentials "injected on egress, never enter sandbox scope" (docs lean on this for OIDC; full API surface less documented than the network-policy primitives).
- **Images**: fixed AL2023 base, runtime install only (sudo OK).
- **Auth**: OIDC (default on Vercel) or access token.
- **TS SDK**: yes, first-class.

### Cloudflare Sandbox SDK — `@cloudflare/sandbox`

- **Primitive**: Container (Cloudflare's container runtime, attached to a Durable Object).
- **Lifecycle**: `getSandbox(env.Sandbox, id)` → `.exec()` / `.writeFile()`; idle stop via `sleepAfter`. State tied to a DO.
- **Cold start**: container boot (seconds cold, warm fast).
- **Pricing**: Cloudflare Containers billing (CPU-ms + GB-s + requests); needs Workers Paid.
- **Execution**: `exec()` blocking, `execStream()` streaming. Full FS. First-class **Code Interpreter** API with persistent Python/JS contexts and auto-parsed rich output (closest equivalent to Jupyter). Background processes, WebSocket browser terminal, preview URLs, R2/S3/GCS bucket mounting.
- **Persistence**: container FS lives while DO is alive; can mount object storage. No memory snapshot/fork.
- **Egress**: programmable via outbound Workers — fully arbitrary JS at the proxy layer.
- **Secret injection**: yes — outbound Worker injects per-host headers; identity-aware via `ctx.containerId`. The most flexible model on the list.
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
- **Egress**: `block_network=True`, `cidr_allowlist` (**CIDR only — IP/range, not hostname**). Sandbox Connect Tokens for authenticated *inbound* HTTP.
- **Secret injection**: no — env vars only, no HTTPS MITM rewrite.
- **Images**: `modal.Image` (Debian slim, pip/apt, registry refs, full Dockerfile).
- **TS SDK**: yes, **beta** (libmodal JS+Go). Python is primary.

### Daytona — `@daytona/sdk`

- **Primitive**: "Sandbox" with dedicated kernel + FS + network stack (VM-grade).
- **Lifecycle**: create → `executeCommand()` / `code_run()` → stop/destroy; stateful snapshots.
- **Cold start**: marketed "<90 ms" — fastest in the list.
- **Pricing**: not transparently public.
- **Execution**: shell exec, `code_run()`, log streaming. Python/TS/JS first-class. Preview proxy for ports.
- **Persistence**: volumes + stateful snapshots for "persistent agent operations."
- **Egress**: CIDR only (max 10, IPv4).
- **Secret injection**: no.
- **Images**: OCI/Docker compatible + templates.
- **TS SDK**: yes, first-class.
- **Notable**: ships an MCP server, VNC for desktop/browser-use, computer-use tool. Most "agent-OS" framing.

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

- **Primitive**: libkrun-backed microVM, each with its own kernel.
- **Lifecycle**: library API → local daemon (`msbserver`). `Sandbox.create("agent", { image: "python:3.12" })`. Snapshot/fork first-class — "fork hundreds of identical sandboxes from one baseline."
- **Cold start**: ~320 ms on bare-metal Linux.
- **Platforms**: Linux (KVM), macOS (HVF), Windows (WSL2).
- **License**: Apache 2.0.
- **Execution**: shell exec, FS, scripts, REPL via long-lived sandbox, process mgmt, port forwarding.
- **Persistence**: OCI image reuse, full snapshots, volumes.
- **Egress**: hostname allowlists, DNS pinning, TLS-edge inspection.
- **Secret injection**: **yes** — placeholders inside the guest swap for real values on verified TLS handshake to allowlisted hosts. Closest local equivalent to E2B/Cloudflare.
- **Images**: any OCI image.
- **TS SDK**: yes (npm `microsandbox`).

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

### Other providers (briefly considered, not in initial pass)

- **Deno Subhosting** — *deploy-code* shape, not *exec-into-VM*. Different abstraction; consider a sibling `CodeRunner` service later.
- **Google Gemini code-execution tool** — hosted model tool; expose via the Gemini adapter, not the sandbox layer.
- **OpenAI / Anthropic hosted code execution** — same: hosted tool, not a sandbox provider.
- **Gondolin** (`@earendil-works/gondolin`) — TS-first microVM control plane, experimental; track for a later local provider.
- **Firecracker raw**, **nsjail/bwrap (without srt)**, **Nix sandbox** — infrastructure used by the providers above; not direct targets.
- **Pyodide, WebContainers, isolated-vm** — different runtimes / different consumers; out of scope for the first pass.

---

## Cross-provider capability matrix

| Capability | Vercel | Cloudflare | E2B | Modal | Daytona | CodeSandbox | Runloop | Microsandbox | BoxLite | Anthropic srt | Docker |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Shell exec + streaming | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| File R/W via SDK | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | host bind | ✓ |
| Expose port → public URL | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | local fwd | local fwd | — | local pub |
| **Snapshot / fork** | ✓ snap | DO state | ✓ pause/resume | ✓ fs-snap | ✓ snap | ✓ **fork** | ✓ snap | ✓ snap/fork | ✓ snap | — | `commit` |
| **Persistent volumes** | beta | DO storage | template | ✓ Volume | ✓ | per-sandbox | mounts | ✓ | ✓ | host bind | ✓ |
| **Egress hostname allowlist** | ✓ SNI | ✓ programmable | ✓ | CIDR only | CIDR only | — | ✓ policies | ✓ | ✓ | ✓ proxy | — (bolt-on) |
| **Proxy secret injection** | partial | ✓ | ✓ | — | — | — | ✓ Gateway | ✓ | unknown | — | — |
| Custom images | — (fixed) | ✓ | ✓ template | ✓ | ✓ | ✓ Dockerfile | ✓ Blueprint | ✓ OCI | ✓ OCI | — | ✓ |
| Stateful REPL / kernel | — | ✓ Code Interp | ✓ Jupyter | — | partial | — | PTY | — | — | — | — |
| PTY session | — | term API | — | — | — | — | ✓ WS | — | — | — | exec -it |

Where providers diverge most (the design decisions the abstraction has to make):

1. **Snapshot semantics.** Eight providers support some form of snapshot, but the shape varies dramatically — E2B/CodeSandbox have memory+disk pause/resume; Modal/Vercel have FS-only; Runloop/Daytona/Microsandbox/BoxLite snapshot then restore as a *new* sandbox. We can't unify into one verb without lying.
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
  readonly create: (request: CommonCreateRequest) => Effect.Effect<SandboxInstance, AiError, Scope.Scope>

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
  | { readonly _tag: "allowlist"; readonly hosts?: ReadonlyArray<string>; readonly cidrs?: ReadonlyArray<string> }

export type BoundSecret = {
  readonly name: string                       // placeholder visible inside sandbox (e.g. "OPENAI_API_KEY")
  readonly value: Redacted.Redacted<string>   // real value, never enters the sandbox
  readonly hosts: ReadonlyArray<string>       // host patterns where injection is allowed
  readonly header?: string                    // default: "Authorization: Bearer <value>"
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

Because the consumer code is then *typed* — `sandbox.snapshot()` only compiles if `SandboxSnapshots` is in the environment. The user picks providers based on the capabilities their code requires; mismatches are a compile error, not a 3 AM `UnsupportedError`. This is exactly the trick used by `TtsIncrementalText` and `MultiSpeakerTts` in [SpeechSynthesizer.ts](packages/core/src/speech-synthesizer/SpeechSynthesizer.ts).

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

1. **Phase 1 — core + 2 cloud providers + 1 local.** Ship `core/sandbox/Sandbox.ts` with the minimal interface (exec, files, ports, destroy), `SandboxPauseResume`, `SandboxKernelSession`, `SandboxHostnameAllowlist`, `SandboxSecretInjection`. Wire **E2B** and **Vercel** as the canonical cloud providers (full capability coverage between them), and **Microsandbox** as the canonical local one. Validate the abstraction by writing one recipe that uses identical code against all three.
2. **Phase 2 — round out cloud.** Add Cloudflare (kernel + secret-injection winner), Modal (volumes), Daytona (PTY-ish + MCP). Add `SandboxSnapshots`, `SandboxVolumes`, `SandboxPty`.
3. **Phase 3 — local + escape hatches.** Add Anthropic srt (process-level), Docker via dockerode, BoxLite. Add `SandboxCustomImage`.
4. **Phase 4 — optional.** CodeSandbox (fork), Runloop (Agent Gateway), the hosted-interpreter fallback Layer, MCP server export.

Each phase adds one capability marker at most — same cadence we used rolling out `MultiSpeakerTts` and `TtsIncrementalText`.
