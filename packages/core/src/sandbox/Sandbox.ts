import { Context, Data, Effect, Redacted, Scope, Stream } from "effect"
import type * as SandboxError from "./SandboxError.js"

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Sandbox identifier. Branded `string` so providers don't accidentally
 * accept a raw user-supplied id. Each provider mints these per its own
 * naming scheme (uuid for E2B/Vercel, user-supplied name for
 * Microsandbox/Modal, …); the core code treats them opaquely.
 */
export type SandboxId = string & { readonly __sandboxId: unique symbol }

/**
 * Reference returned by `list`. Carries just enough to call `attach` —
 * provider-specific metadata (createdAt, region, tags, …) lives on the
 * narrowed per-provider ref.
 */
export type SandboxRef = {
  readonly id: SandboxId
  readonly name?: string
}

export type VolumeId = string & { readonly __volumeId: unique symbol }

export type SnapshotId = string & { readonly __snapshotId: unique symbol }

// ---------------------------------------------------------------------------
// Image / runtime selection
// ---------------------------------------------------------------------------

/**
 * What runtime / filesystem to boot the sandbox from.
 *
 * - `Default` — provider picks its house image (Vercel: Amazon Linux
 *   2023; Microsandbox: requires user image but a builder default may
 *   apply, …). Use when you don't care what's pre-installed.
 * - `Registry` — an OCI image reference. Supported by every provider
 *   except those with a fixed base (Vercel ignores this and the
 *   request-schema rejects at decode).
 * - `Snapshot` — restore from a captured state. Gated by
 *   {@link SandboxSnapshots} at the call site — the marker is provided
 *   by adapters whose provider supports snapshot-as-image.
 * - `Dockerfile` — provider builds a custom image from a Dockerfile.
 *   Gated by {@link SandboxCustomImage}.
 */
export type ImageRef = Data.TaggedEnum<{
  Default: {}
  Registry: { readonly ref: string }
  Snapshot: { readonly id: SnapshotId }
  Dockerfile: { readonly contents: string }
}>

export const ImageRef = Data.taggedEnum<ImageRef>()

// ---------------------------------------------------------------------------
// Network policy + secrets
// ---------------------------------------------------------------------------

/**
 * Outbound network policy for a sandbox.
 *
 * - `Open` — no egress restriction. The provider's defaults apply
 *   (e.g. Microsandbox's "public-only" still blocks private ranges).
 * - `Blocked` — fully airgapped, no outbound connectivity at all.
 * - `Allowlist` — only the listed hosts / CIDRs may be reached.
 *
 * Providers vary in what they honour: hostname-allowlist requires
 * {@link SandboxHostnameAllowlist}; CIDR-only providers ignore `hosts`
 * and the adapter rejects at decode if `hosts` is non-empty.
 */
export type NetworkPolicy = Data.TaggedEnum<{
  Open: {}
  Blocked: {}
  Allowlist: {
    readonly hosts?: ReadonlyArray<string>
    readonly cidrs?: ReadonlyArray<string>
  }
}>

export const NetworkPolicy = Data.taggedEnum<NetworkPolicy>()

/**
 * A secret bound to a sandbox at create time. The code inside the
 * sandbox sees only a placeholder (`$MSB_<NAME>` for Microsandbox,
 * `{name}` for Vercel header-injection, etc.); the real `value` lives
 * on the provider's proxy and is substituted on outbound HTTPS to
 * `hosts`.
 *
 * Requires the {@link SandboxSecretInjection} capability marker —
 * provider Layers without proxy-layer secret rewriting do not ship the
 * marker and consumer code fails at `Effect.provide` with a type
 * error.
 *
 * `header` is the request header to inject (default
 * `"Authorization: Bearer <value>"`). Providers that do not let
 * callers pick the header (Microsandbox's `secretEnv` shorthand)
 * silently ignore this field; providers that require an explicit
 * header (Vercel's `transform.headers`) fail at decode if it's absent.
 */
export type BoundSecret = {
  readonly name: string
  readonly value: Redacted.Redacted<string>
  readonly hosts: ReadonlyArray<string>
  readonly header?: string
}

// ---------------------------------------------------------------------------
// Volumes (capability-gated on `SandboxVolumes`)
// ---------------------------------------------------------------------------

export type VolumeMount = {
  readonly id: VolumeId
  readonly mountPath: string
  readonly readonly?: boolean
}

// ---------------------------------------------------------------------------
// Create / exec request shapes
// ---------------------------------------------------------------------------

/**
 * Cross-provider create request. Provider-specific knobs (region,
 * cpus, memory, template id, …) live on each provider's narrowed
 * request type which extends this.
 *
 * Fields a provider can't honour fail at **decode time** (per the
 * per-provider request schema), not silently at runtime. The
 * ComputeSDK anti-pattern of "drop unsupported fields" is the
 * footgun we're avoiding.
 */
export type CommonCreateRequest = {
  /** Image / snapshot to boot from. Omit for the provider's default. */
  readonly image?: ImageRef
  /** Idle / hard timeout in milliseconds. Providers default differently. */
  readonly timeoutMs?: number
  /**
   * Env vars exposed to the sandbox. NOT for secrets you want hidden
   * from the running code — use {@link BoundSecret} instead.
   */
  readonly env?: Readonly<Record<string, string>>
  /** Outbound network policy. */
  readonly network?: NetworkPolicy
  /**
   * Bound secrets — code inside the sandbox sees a placeholder; the
   * proxy substitutes the real value on outbound HTTPS to listed hosts.
   * Capability-gated on {@link SandboxSecretInjection}.
   */
  readonly secrets?: ReadonlyArray<BoundSecret>
  /**
   * Persistent volumes to mount. Volumes are created via
   * `Sandbox.volumes.create` and survive sandbox lifetime.
   * Capability-gated on {@link SandboxVolumes}.
   */
  readonly volumes?: ReadonlyArray<VolumeMount>
}

/**
 * Cross-provider exec request. Background / long-running processes
 * use `spawn` instead of `exec`; the semantics differ enough that
 * overloading `exec` with a `detached` flag was rejected during
 * design.
 */
export type CommonExecRequest = {
  /**
   * Argv-style command. Pass a string for "run this through the
   * shell" semantics (provider-dependent — most use `sh -c`); pass
   * an array for direct argv with no shell parsing.
   */
  readonly cmd: string | ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  readonly stdin?: string | Uint8Array
  /** Per-exec timeout in milliseconds. */
  readonly timeoutMs?: number
}

export type ExecResult = {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

/**
 * Streaming exec output. `Complete` is terminal — the stream
 * completes after emitting it.
 */
export type ExecEvent = Data.TaggedEnum<{
  Stdout: { readonly chunk: Uint8Array }
  Stderr: { readonly chunk: Uint8Array }
  Complete: { readonly exitCode: number; readonly durationMs: number }
}>

export const ExecEvent = Data.taggedEnum<ExecEvent>()

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export type FileEntryKind = "file" | "directory" | "symlink" | "other"

export type FileEntry = {
  readonly path: string
  readonly kind: FileEntryKind
}

export type SandboxFilesystem = {
  readonly read: (path: string) => Effect.Effect<Uint8Array, SandboxError.SandboxError>
  readonly write: (
    path: string,
    contents: Uint8Array | string,
  ) => Effect.Effect<void, SandboxError.SandboxError>
  readonly remove: (path: string) => Effect.Effect<void, SandboxError.SandboxError>
  readonly mkdir: (path: string) => Effect.Effect<void, SandboxError.SandboxError>
  readonly list: (
    path: string,
  ) => Effect.Effect<ReadonlyArray<FileEntry>, SandboxError.SandboxError>
  readonly exists: (path: string) => Effect.Effect<boolean, SandboxError.SandboxError>
}

// ---------------------------------------------------------------------------
// Process handle (returned by `spawn`)
// ---------------------------------------------------------------------------

/**
 * Long-running process handle. Returned by `spawn` in a `Scope.Scope`
 * — the process is killed on scope close. To outlive the calling
 * scope, do `Effect.forkScoped` against a wider scope or use
 * `attach`-style reconnection per the provider's escape hatch.
 */
export type ProcessHandle = {
  readonly pid: number
  readonly events: Stream.Stream<ExecEvent, SandboxError.SandboxError>
  readonly kill: Effect.Effect<void, SandboxError.SandboxError>
  readonly exit: Effect.Effect<{ readonly exitCode: number }, SandboxError.SandboxError>
}

// ---------------------------------------------------------------------------
// SandboxInstance — the live handle returned from `create` / `attach`
// ---------------------------------------------------------------------------

/**
 * Live sandbox handle. Methods are plain `Effect` / `Stream` values
 * — no nullary thunks (`destroy()`, `pause()`) — to match Effect's
 * `Queue.shutdown` / `Fiber.interrupt` style. Destruction is the
 * scope finalizer, not a method here; for the rare "kill from
 * another fiber" case use the service-level escape hatch
 * `Sandbox.destroy(id)`.
 */
export type SandboxInstance = {
  readonly id: SandboxId
  readonly exec: (
    request: CommonExecRequest,
  ) => Effect.Effect<ExecResult, SandboxError.SandboxError>
  readonly execStream: (
    request: CommonExecRequest,
  ) => Stream.Stream<ExecEvent, SandboxError.SandboxError>
  /**
   * Spawn a background / long-running process. The returned handle is
   * scoped — the process is killed on scope close. Use this for
   * "dev server / watcher / tail -f" workloads. For one-shot
   * commands prefer `exec`.
   */
  readonly spawn: (
    request: CommonExecRequest,
  ) => Effect.Effect<ProcessHandle, SandboxError.SandboxError, Scope.Scope>
  readonly files: SandboxFilesystem
  /**
   * Expose an internal port; returns a public URL. Capability-gated
   * on {@link SandboxPortExposure}.
   */
  readonly exposePort: (
    port: number,
  ) => Effect.Effect<{ readonly url: string }, SandboxError.SandboxError>
}

// ---------------------------------------------------------------------------
// Snapshot + volume sub-services (capability-gated)
// ---------------------------------------------------------------------------

export type SandboxSnapshotsApi = {
  readonly create: (
    from: SandboxInstance,
    name?: string,
  ) => Effect.Effect<SnapshotId, SandboxError.SandboxError>
  readonly destroy: (id: SnapshotId) => Effect.Effect<void, SandboxError.SandboxError>
  readonly list: Effect.Effect<
    ReadonlyArray<{ readonly id: SnapshotId; readonly name?: string }>,
    SandboxError.SandboxError
  >
}

export type SandboxVolumesApi = {
  readonly create: (
    name: string,
    options?: { readonly quotaBytes?: number },
  ) => Effect.Effect<VolumeId, SandboxError.SandboxError>
  readonly destroy: (id: VolumeId) => Effect.Effect<void, SandboxError.SandboxError>
  readonly list: Effect.Effect<
    ReadonlyArray<{ readonly id: VolumeId; readonly name: string }>,
    SandboxError.SandboxError
  >
}

// ---------------------------------------------------------------------------
// Service definition
// ---------------------------------------------------------------------------

/**
 * Cross-provider sandbox service.
 *
 * Lifetime model: `create` returns a sandbox handle in `Scope.Scope`.
 * The scope finalizer destroys the sandbox. Use `Effect.scoped` to
 * bound a sandbox's lifetime to a single Effect, or manage the scope
 * explicitly via `Scope.make` for sandboxes that span many calls.
 * This is why there's no `destroy()` method on `SandboxInstance` —
 * the scope is the lifecycle handle.
 *
 * `snapshots` and `volumes` sub-APIs are present on the service but
 * are still capability-gated: provider Layers that don't support
 * them ship implementations that always fail with
 * `SandboxUnsupported`. The free helpers ({@link snapshot},
 * {@link createVolume}) additionally require the corresponding
 * capability marker on R, so misuses surface as type errors at
 * `Effect.provide`, not as runtime failures.
 */
export type SandboxService = {
  /**
   * Provision a new sandbox. The returned handle's lifetime is
   * bound to the caller's scope; the sandbox is destroyed on scope
   * close. To survive the scope, use `attach`-style reconnection or
   * promote into a wider scope.
   */
  readonly create: (
    request: CommonCreateRequest,
  ) => Effect.Effect<SandboxInstance, SandboxError.SandboxError, Scope.Scope>

  /**
   * Re-acquire an existing sandbox by id. The returned handle is
   * scope-bound but the finalizer is "detach" (no destroy) —
   * appropriate for paused / detached / persistent sandboxes that
   * outlive any single agent run.
   */
  readonly attach: (
    id: SandboxId,
  ) => Effect.Effect<SandboxInstance, SandboxError.SandboxError, Scope.Scope>

  /**
   * Enumerate sandboxes visible to the configured account / project.
   */
  readonly list: Effect.Effect<ReadonlyArray<SandboxRef>, SandboxError.SandboxError>

  /**
   * Escape hatch for destroying a sandbox from outside its owning
   * scope. Most callers should let the scope finalizer handle this.
   */
  readonly destroy: (id: SandboxId) => Effect.Effect<void, SandboxError.SandboxError>

  /** Snapshot management. Capability-gated on {@link SandboxSnapshots}. */
  readonly snapshots: SandboxSnapshotsApi

  /** Volume management. Capability-gated on {@link SandboxVolumes}. */
  readonly volumes: SandboxVolumesApi
}

export class Sandbox extends Context.Service<Sandbox, SandboxService>()(
  "@betalyra/effect-uai/Sandbox",
) {}

// ---------------------------------------------------------------------------
// Capability markers
// ---------------------------------------------------------------------------

/**
 * Capability marker — provided by adapter Layers whose provider
 * supports a hostname-level egress allowlist (matching against host
 * names / wildcards, not just CIDRs). Vercel, Cloudflare, Deno,
 * Microsandbox, Runloop, Anthropic srt ship this marker; Modal and
 * Daytona (CIDR-only) do not.
 *
 * Phantom — the value is `void`; adapters register with
 * `Layer.succeed(SandboxHostnameAllowlist, undefined)`.
 */
export class SandboxHostnameAllowlist extends Context.Service<SandboxHostnameAllowlist, void>()(
  "@betalyra/effect-uai/capability/SandboxHostnameAllowlist",
) {}

/**
 * Capability marker — adapter's provider supports proxy-layer
 * secret rewriting (header injection on outbound HTTPS to bound
 * hosts; the running code never sees the real value). Deno,
 * Cloudflare, E2B, Vercel (firewall transform), Microsandbox,
 * Runloop (Agent Gateway) ship this. Modal, Daytona, CodeSandbox
 * do not.
 */
export class SandboxSecretInjection extends Context.Service<SandboxSecretInjection, void>()(
  "@betalyra/effect-uai/capability/SandboxSecretInjection",
) {}

/**
 * Capability marker — adapter supports snapshot-as-new-sandbox
 * (capture state, restore as a derived sandbox with a fresh id).
 * Distinct from {@link SandboxPauseResume}, which preserves the
 * same id and resumes in place.
 */
export class SandboxSnapshots extends Context.Service<SandboxSnapshots, void>()(
  "@betalyra/effect-uai/capability/SandboxSnapshots",
) {}

/**
 * Capability marker — adapter supports in-place pause and resume on
 * the same sandbox id (E2B, CodeSandbox). Memory + processes are
 * preserved across the pause boundary. Most providers without this
 * marker offer {@link SandboxSnapshots} instead.
 */
export class SandboxPauseResume extends Context.Service<SandboxPauseResume, void>()(
  "@betalyra/effect-uai/capability/SandboxPauseResume",
) {}

/**
 * Capability marker — adapter manages named persistent volumes
 * outside any single sandbox lifecycle (Modal Volume, Daytona,
 * Microsandbox, BoxLite). Providers without this marker leave
 * `Sandbox.volumes.*` returning `SandboxUnsupported`; the free
 * helpers ({@link createVolume}, {@link destroyVolume}) additionally
 * require this marker on R so misuses become a type error.
 */
export class SandboxVolumes extends Context.Service<SandboxVolumes, void>()(
  "@betalyra/effect-uai/capability/SandboxVolumes",
) {}

/**
 * Capability marker — adapter supports a stateful kernel session
 * (Jupyter-style: persistent Python / JS context that returns rich
 * outputs across many `runCode` calls). Cloudflare Code Interpreter
 * and E2B ship this; everyone else expects you to write your own
 * script and `exec` it.
 *
 * The actual `runCode` helper lives separately (not on
 * `SandboxInstance`) because the return shape is different — rich
 * outputs with images/tables, not buffered stdout strings.
 */
export class SandboxKernelSession extends Context.Service<SandboxKernelSession, void>()(
  "@betalyra/effect-uai/capability/SandboxKernelSession",
) {}

/**
 * Capability marker — adapter exposes an interactive PTY session
 * (Runloop, Cloudflare terminal). Distinct from `execStream` which
 * is byte-oriented and one-shot.
 */
export class SandboxPty extends Context.Service<SandboxPty, void>()(
  "@betalyra/effect-uai/capability/SandboxPty",
) {}

/**
 * Capability marker — adapter accepts a user-supplied Dockerfile (or
 * OCI image build) instead of just a registry reference. Vercel does
 * not ship this (fixed AL2023). Deno does not (snapshots only).
 * Most others do.
 */
export class SandboxCustomImage extends Context.Service<SandboxCustomImage, void>()(
  "@betalyra/effect-uai/capability/SandboxCustomImage",
) {}

/**
 * Capability marker — adapter can expose an internal port as a
 * publicly reachable URL. Most cloud providers ship this; local
 * providers (Microsandbox, BoxLite) typically only support
 * host-side port forwarding (handled by ignoring this marker and
 * documenting via the per-provider request type).
 */
export class SandboxPortExposure extends Context.Service<SandboxPortExposure, void>()(
  "@betalyra/effect-uai/capability/SandboxPortExposure",
) {}

// ---------------------------------------------------------------------------
// Free helpers — accept Sandbox via Context, optionally require markers.
// ---------------------------------------------------------------------------

/**
 * Provision a sandbox bound to the caller's scope. Drop the
 * `Scope.Scope` requirement with `Effect.scoped`.
 */
export const create = (
  request: CommonCreateRequest,
): Effect.Effect<SandboxInstance, SandboxError.SandboxError, Sandbox | Scope.Scope> =>
  Effect.flatMap(Sandbox.asEffect(), (s) => s.create(request))

/**
 * Re-acquire an existing sandbox by id. Same scope semantics as
 * `create`, but the finalizer detaches rather than destroying.
 */
export const attach = (
  id: SandboxId,
): Effect.Effect<SandboxInstance, SandboxError.SandboxError, Sandbox | Scope.Scope> =>
  Effect.flatMap(Sandbox.asEffect(), (s) => s.attach(id))

/** Enumerate sandboxes for the configured account / project. */
export const list = (): Effect.Effect<
  ReadonlyArray<SandboxRef>,
  SandboxError.SandboxError,
  Sandbox
> => Effect.flatMap(Sandbox.asEffect(), (s) => s.list)

/**
 * Escape hatch for destroying a sandbox from outside its owning
 * scope. Most callers should let the scope finalizer handle this
 * automatically.
 */
export const destroy = (id: SandboxId): Effect.Effect<void, SandboxError.SandboxError, Sandbox> =>
  Effect.flatMap(Sandbox.asEffect(), (s) => s.destroy(id))

/**
 * Create a snapshot of a live sandbox. Requires
 * {@link SandboxSnapshots} on the R channel — adapters whose
 * provider doesn't support snapshot-as-new-sandbox don't ship the
 * marker and calls fail at `Effect.provide` with a type error.
 */
export const snapshot = (
  from: SandboxInstance,
  name?: string,
): Effect.Effect<SnapshotId, SandboxError.SandboxError, Sandbox | SandboxSnapshots> =>
  Effect.gen(function* () {
    const s = yield* Sandbox.asEffect()
    yield* SandboxSnapshots.asEffect()
    return yield* s.snapshots.create(from, name)
  })

/**
 * Create a named persistent volume. Requires {@link SandboxVolumes}.
 */
export const createVolume = (
  name: string,
  options?: { readonly quotaBytes?: number },
): Effect.Effect<VolumeId, SandboxError.SandboxError, Sandbox | SandboxVolumes> =>
  Effect.gen(function* () {
    const s = yield* Sandbox.asEffect()
    yield* SandboxVolumes.asEffect()
    return yield* s.volumes.create(name, options)
  })

/** Destroy a named volume. Requires {@link SandboxVolumes}. */
export const destroyVolume = (
  id: VolumeId,
): Effect.Effect<void, SandboxError.SandboxError, Sandbox | SandboxVolumes> =>
  Effect.gen(function* () {
    const s = yield* Sandbox.asEffect()
    yield* SandboxVolumes.asEffect()
    return yield* s.volumes.destroy(id)
  })
