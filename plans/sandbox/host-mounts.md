# Host Directory Mounts — Sandbox capability plan

**Status:** proposed · drafted 2026-09-17
**Touches:** `@effect-uai/core` (capability marker + type), `@effect-uai/microsandbox` (narrowed request + builder step + layer), `docs/sandboxes/*`, `integration-tests/sandbox-microsandbox`.

---

## Why this exists

The sandbox core is deliberately **hermetic and portable**. `CommonCreateRequest` carries
`image`, `timeout`, `env`, `network`, `secrets`, and `volumes` (named persistent volumes);
data crosses the boundary explicitly through `SandboxInstance.exec`/`execStream`/`spawn`
and `SandboxInstance.files`. That contract is right for cloud providers (Vercel, E2B, Deno,
Modal, Cloudflare), none of which can bind-mount a directory from the caller's machine.

But there is a large, common class of **local agentic workloads** that needs exactly that:
a coding agent whose _own_ tools (host-side read/edit) and the _sandboxed_ execution (guest
shell) share one filesystem tree. This is microsandbox's own flagship pattern — the official
docs' OpenCode, Claude Code, Codex, and VS Code examples all do
`--mount-dir ./project:/workspace:rw` and run the agent against that mount.

Today effect-uai cannot express this on any provider:

- `workdir` only sets the guest cwd; it does not place host files in the guest.
- `VolumeMount` (`CommonCreateRequest.volumes`) is `{ id: VolumeId; mountPath; readonly? }` —
  a _provider-managed named volume_; the microsandbox adapter wires it to `m.named(vol.id)`.
- There is no field for "bind host directory `H` at guest path `G`".

The underlying microsandbox runtime already supports this: `VolumeMountKind` is
`"bind" | "named" | "owned" | "tmpfs" | "disk"`, and the SDK builder exposes
`volume(guest, (m) => m.bind(hostPath)[.readonly()])`. The gap is in the **adapter surface
and the capability model**, not the runtime.

### Where this was discovered

While building an OpenCode V2 plugin that overrides the `shell` tool to execute inside a
per-project microVM while OpenCode's host-side `read`/`edit` tools operate on the same
worktree. The plugin currently bypasses effect-uai and drives `microsandbox` directly
because of this gap.

---

## Problem statement

There is no honest, type-safe way, through effect-uai, to bind-mount a host directory into a
sandbox. Callers who need it must drop to the raw provider SDK and lose the service/layer
model, scope-bound lifecycle, typed error mapping, and integration with `network`/`secrets`.

---

## Design goals / non-goals

**Goals**

- Expressible through the **provider-narrowed** surface, not the portable core contract.
- **Capability-gated**: portable code that needs it is a compile error on providers that
  can't do it (the existing marker idiom).
- Honest about locality, portability, and the security trade-off.
- Purely additive: zero change to `CommonCreateRequest` or existing behavior.

**Non-goals**

- Making host mounts portable. They are local-only by nature; pretending otherwise is the
  "silently drop unsupported fields" footgun the sandbox plans explicitly reject.
- Host↔guest file _copy_ / sync-in / sync-out semantics (a different primitive; see
  [Alternatives](#alternatives-considered)).
- Remote/cloud bind mounts.

---

## Proposed design

### 1. Core — capability marker + shared type

In `packages/core/src/sandbox/Sandbox.ts`, next to the other capability markers:

```ts
/**
 * Capability marker — the adapter provider can bind-mount a caller-supplied
 * *host* directory into the guest at a chosen path (live, shared filesystem),
 * as opposed to a provider-managed named volume.
 *
 * Local-only in practice: hosted providers cannot see the caller's disk.
 * Phantom — adapters register with `Layer.succeed(SandboxHostMounts, undefined)`.
 */
export class SandboxHostMounts extends Context.Service<SandboxHostMounts, void>()(
  "@betalyra/effect-uai/capability/SandboxHostMounts",
) {}
```

And a shared value type near `VolumeMount`:

```ts
/**
 * A host directory exposed inside the sandbox. Both paths are absolute.
 * `readonly` mounts the host tree read-only in the guest.
 *
 * Distinct from `VolumeMount` (a provider-managed named volume). Host mounts
 * point at a directory on the caller's machine and are local-only.
 */
export type HostMount = {
  readonly hostPath: string
  readonly mountPath: string
  readonly readonly?: boolean
}
```

Deliberately **no** free helper in core. Because the field is provider-narrowed (see below),
a generic `Sandbox.create({ mounts })` cannot exist without a `CommonCreateRequest` change,
which is out of scope. The marker + type are the reusable contract; each local adapter adds
the narrowed field.

### 2. Adapter — `mounts` on `MicrosandboxCreateRequest`

In `packages/providers/microsandbox/src/MicrosandboxSandbox.ts`:

```ts
import { type HostMount /* ... */ } from "@effect-uai/core/Sandbox"

export type MicrosandboxCreateRequest = Omit<CommonCreateRequest, "secrets"> & {
  readonly secrets?: ReadonlyArray<MicrosandboxBoundSecret>
  // ...existing narrowed fields...
  /**
   * Host directories bind-mounted into the guest. Local-only. Requires the
   * `SandboxHostMounts` marker, which this layer ships.
   */
  readonly mounts?: ReadonlyArray<HostMount>
}
```

Builder step, modelled on the existing `volumeStep` / `secretStep` / `networkStep`:

```ts
const hostMountStep =
  (mount: HostMount): Step =>
  (b) =>
    b.volume(mount.mountPath, (m) =>
      mount.readonly ? m.bind(mount.hostPath).readonly() : m.bind(mount.hostPath),
    )
```

Wire it into the fold in `acquireSandbox` alongside the existing steps:

```ts
const steps: ReadonlyArray<Step> = [
  img,
  // ...cpus/memory/workdir/user/timeouts/env...
  when(request.network, networkStep),
  ...Arr.map(request.secrets ?? [], secretStep),
  ...Arr.map(request.volumes ?? [], volumeStep),
  ...Arr.map(request.mounts ?? [], hostMountStep), // ← new
  replaceStep(request.replace),
]
```

Ship the marker in `layer`:

```ts
return Layer.mergeAll(
  Layer.succeed(MicrosandboxSandbox, service),
  Layer.succeed(CoreSandbox, upcastService(service)),
  Layer.succeed(SandboxHostnameAllowlist, undefined),
  Layer.succeed(SandboxSecretInjection, undefined),
  Layer.succeed(SandboxSnapshots, undefined),
  Layer.succeed(SandboxVolumes, undefined),
  Layer.succeed(SandboxHostMounts, undefined), // ← new
)
```

**Generic-surface handling.** `mounts` is not on `CommonCreateRequest`, so callers routing
through the portable `Sandbox.create` surface cannot set it — nothing to reject in
`upcastService`. (If `HostMount` is ever promoted to core, add a decode-time rejection for
providers that don't ship the marker, following the existing `rejectCustomHeader` row-D
pattern.)

**Validation (fail fast with `SandboxInvalidRequest`).**

- `hostPath` and `mountPath` must be absolute.
- Duplicate `mountPath` entries, or a `mountPath` colliding with a `volumes[].mountPath`,
  should fail rather than silently let the last write win.
- A `hostPath` that does not exist on the host should surface a clear create failure
  rather than being swallowed.

### 3. Semantics to pin down and document

- **Local-only.** Mark the docs with the local-only badge like the other local-only
  features. The marker is shipped by the microsandbox layer only.
- **Identity path mapping.** Mounting `hostPath === mountPath` makes absolute paths resolve
  identically on both sides. This is the OpenCode-plugin use case and should be an
  explicitly documented pattern (not a requirement).
- **Live sharing, not a copy.** Guest writes appear on the host immediately and vice versa.
  `readonly: true` is the safe default for host trees the sandbox shouldn't mutate.
- **Lifecycle.** `destroy`/`remove` leaves bind-mounted host files intact (matches the
  microsandbox docs' removal table). Detached sandboxes keep their mounts across
  stop/start because the mount is part of the persisted config; `attach` therefore
  re-connects with the original mounts.
- **`workdir` interplay.** For the shared-tree use case, set `workdir` to the guest
  `mountPath` so default `exec` cwd lands inside the mounted tree.
- **Mount-root symlink protection.** microsandbox applies symlink protection on mount roots
  by default; note it and verify interaction with `readonly` on the current runtime.

### 4. Docs

- `docs/sandboxes/providers/microsandbox.md`
  - Add `mounts` to the **Request shape** block.
  - Add a **Host directory mounts** section (example: mount `./my-project` rw, identity-path
    variant, `readonly` variant) with the local-only callout.
  - Add a **Capabilities** row: `SandboxHostMounts` → ✓.
  - Note `destroy` leaves host files intact.
- `docs/sandboxes/index.md`
  - Add `SandboxHostMounts` to the capability table and provider matrix.
  - Add a short "Share a host directory with the sandbox" subsection under the local-provider
    discussion, explicitly framed as non-portable.

### 5. Tests

**Unit / type-level**

- The microsandbox layer provides `SandboxHostMounts`; the Deno layer does not.
- A helper requiring `SandboxHostMounts` on `R` fails to typecheck against an unmarked layer.
- `MicrosandboxCreateRequest.mounts` accepts `HostMount[]`; the generic `Sandbox.create`
  signature does not expose `mounts`.

**Integration** (`integration-tests/sandbox-microsandbox`)

- Create with a temp host dir mounted rw; `exec` writes a file; assert the file exists on
  the host and that host edits are visible in the guest (identity path mapping variant too).
- `readonly: true` mount: guest write fails.
- `destroy` leaves host files intact.
- Duplicate/colliding `mountPath` and relative paths fail with `SandboxInvalidRequest`.
- Detached create + `attach` preserves the mount.

**Environment note.** Record the version-skew lesson that blocked the first implementation:
the `msb` runtime and the `microsandbox` SDK/native binding must be on the same minor
(the `0.7.0` SDK against a `0.7.1` runtime produced a misleading
`InvalidConfigError: field config.cmd cannot be preserved` at create). Integration tests
should assert/align versions.

### 6. Compatibility

- Purely additive; no breaking change to core types or existing providers.
- Other local adapters (BoxLite, Docker, `.qcow2`/rootfs roots) can opt in later by shipping
  the same `SandboxHostMounts` marker and a `mounts` field.

---

## Alternatives considered

- **Add `mounts` to `CommonCreateRequest` (portable core).** Rejected: most providers cannot
  honour it, so it would need decode-time rejection on the majority of the matrix, and it
  turns a deliberate isolation boundary into a first-class portability feature. This is the
  exact anti-pattern the sandbox plans call out.
- **Model host mounts as named volumes.** Not possible: `VolumeMount` addresses a
  provider-managed volume id, not an arbitrary host path.
- **Auto copy-in/copy-out (`--copy-dir` semantics).** Different problem: isolated snapshot
  rather than a live shared tree. If desired, a separate capability
  (`SandboxWorkspaceCopy`) and a narrow request field — not this plan.
- **Callers drive the provider SDK directly.** Works, but loses the service/layer,
  scope-bound lifecycle, typed errors, and `network`/`secrets` composition. Acceptable as a
  stopgap, not as the library's answer.

---

## Open questions

1. **Name.** `SandboxHostMounts` vs `SandboxHostBindMounts` vs `SandboxLocalMounts`.
   Leaning `SandboxHostMounts` (counterpart to `SandboxVolumes`).
2. **Field placement.** Separate `mounts` field vs extending `VolumeMount` with a `host`
   variant. Leaning separate: keeps "persistent provider volume" and "host bind"
   conceptually distinct, and avoids widening the portable `VolumeMount`.
3. **Canonical workspace concept.** Should effect-uai offer a higher-level "one shared
   workspace + `workdir`" convenience on top of `mounts`, or stay primitive? Leaning
   primitive for now; a recipe/pattern doc can cover the common case.
4. **Validation strictness.** How aggressive to be about overlapping/duplicate mount paths
   and non-existent host paths (hard error vs pass-through to the runtime error)? Leaning
   hard error for collisions, runtime error for missing host path.
5. **Symlink protection + `readonly`.** Verify current runtime behaviour and document.

---

## Implementation checklist

1. `packages/core/src/sandbox/Sandbox.ts`: add `SandboxHostMounts` marker + `HostMount` type;
   export through the package's `./Sandbox` entry.
2. `packages/providers/microsandbox/src/MicrosandboxSandbox.ts`:
   add `mounts?` to `MicrosandboxCreateRequest`; add `hostMountStep`; include it in the
   `steps` fold; `Layer.succeed(SandboxHostMounts, undefined)`; add validation helpers and
   map failures to `SandboxError.SandboxInvalidRequest`.
3. `docs/sandboxes/providers/microsandbox.md` + `docs/sandboxes/index.md`: request shape,
   host-mount section, capability/matrix rows, local-only notes.
4. `integration-tests/sandbox-microsandbox`: rw + readonly + identity-path + destroy-leaves-
   files + collision/validation + detached/attach cases; version alignment guard.
5. Changeset / version bump for `@effect-uai/core` and `@effect-uai/microsandbox`.

---

## References

- microsandbox docs — OpenCode example (host project mount): <https://docs.microsandbox.dev/examples/agents/opencode>
- microsandbox docs — Volumes: <https://docs.microsandbox.dev/sandboxes/volumes>
- microsandbox docs — Security / filesystem: <https://docs.microsandbox.dev/security/filesystem>
- effect-uai core capability markers: `packages/core/src/sandbox/Sandbox.ts`
- effect-uai microsandbox adapter: `packages/providers/microsandbox/src/MicrosandboxSandbox.ts`
- related plans: `plans/sandbox.md`, `plans/sandbox/deno.md`
