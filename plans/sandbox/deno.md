# Deno Sandbox provider

Implementation plan for `@effect-uai/deno-sandbox` — an adapter that wraps
[`@deno/sandbox`](https://docs.deno.com/sandbox/) behind the cross-provider
[`Sandbox`](../../packages/core/src/sandbox/Sandbox.ts) service. Mirrors
[`@effect-uai/microsandbox`](../../packages/providers/microsandbox/src/MicrosandboxSandbox.ts)
in shape, file layout, and integration-test pattern.

Note on the runtime: `@deno/sandbox` is published on JSR **and** npm and runs
fine from plain Node — the provider does not require Deno itself. Verifying
that the whole `effect-uai` library works when consumed from a Deno runtime
is a worthwhile follow-up but is a separate workstream — see
[Phase D](#phase-d-deferred--validate-effect-uai-on-the-deno-runtime).

## What we get from Deno Sandbox

Verified against [docs.deno.com/sandbox](https://docs.deno.com/sandbox) as
of 2026-05-23. Re-check before locking down the adapter.

- **Primitive**: Firecracker microVM on the Deno Deploy edge. Boot under 1 s.
- **Auth**: `DENO_DEPLOY_TOKEN` env var, generated from the Deno Deploy
  dashboard. The SDK picks it up from the environment.
- **Lifecycle**: `Sandbox.create(opts)` returns an `await using` resource;
  `Sandbox.connect({ id })` re-acquires by id; `sandbox.kill()` terminates;
  `sandbox.extendTimeout("30m")` extends.
- **Execution**: `sandbox.sh\`cmd\`` tagged-template (one-shot), the same
  with `.spawn()` for long-running. Returns stdout/stderr/exit shapes
  similar to `Deno.Command`.
- **Filesystem**: `sandbox.fs.{writeTextFile, readTextFile, mkdir, remove,
  readDir, …}` — Deno-`Deno.fs`-shaped.
- **Networking**: `allowNet: string[]` accepts hostnames (with wildcards
  like `*.anthropic.com`), `host:port` pairs, and exact IPv4/IPv6 literals.
  **No CIDR notation.**
- **Secrets**: `secrets: Record<name, { hosts, value }>` — placeholder
  in-VM, real value injected at the proxy boundary on outbound HTTPS to
  listed hosts. No per-secret custom header field.
- **Ports**: `port` at create time (auto-exposed, `sandbox.url` returns
  the preview URL) **or** `sandbox.exposeHttp({ port })` later.
- **Volumes**: managed via the separate `Client` class —
  `client.volumes.{create, list, get, delete}`. Mounted by slug:
  `volumes: { "/data": "slug" }`. Region must match.
- **Snapshots**: read-only, created **from a volume** via
  `client.volumes.snapshot(volumeId, { slug })`. Booting from a snapshot
  uses `root: "snapshot-slug"`. This does **not** match our
  `snapshots.create(from: SandboxInstance)` contract — see
  [Snapshot mismatch](#snapshot-mismatch) below.
- **Regions**: `ams`, `ord`. Volumes are currently `ord`-only.
- **Resources**: 2 vCPU, 768–4096 MB RAM (default 1.2 GB), 10 GB ephemeral
  disk. Max 30 min lifetime, max 5 sandboxes/org in pre-release.
- **Custom images**: not supported. `image: "python:3.12"`-style requests
  are out — snapshots are the only "pre-installed software" path.
- **Pricing**: TBD at GA. Skip cost telemetry until finalized.

## Capability markers shipped

The Deno layer registers these markers on `Sandbox`:

- `SandboxHostnameAllowlist` — `allowNet` accepts hostnames + wildcards.
- `SandboxSecretInjection` — proxy-layer secret rewriting.
- `SandboxSnapshots` — read side (`list`, `destroy`) only; `create` from a
  live instance fails with `SandboxUnsupported` (see below).
- `SandboxVolumes` — first-class `client.volumes.*`.
- `SandboxPortExposure` — `exposeHttp` returns a real public URL.

**Not** shipped (compile-time gate against misuse):

- `SandboxCustomImage` — no Dockerfile / no OCI image refs.
- `SandboxPauseResume` — Deno only does the "snapshot-as-image" model.
- `SandboxKernelSession`, `SandboxPty` — no Jupyter, no PTY.

## Type mapping

### Image (`ImageRef` → Deno `root`)

| `ImageRef`              | Deno equivalent                                 |
| ----------------------- | ----------------------------------------------- |
| `Default`               | omit `root` (Deno's default base)               |
| `Snapshot({ id })`      | `root: id` (snapshot slug)                      |
| `Registry({ ref })`     | **reject** with `SandboxUnsupported`            |
| `Dockerfile({ ... })`   | **reject** with `SandboxUnsupported`            |

### Network (`NetworkPolicy` → `allowNet`)

| `NetworkPolicy`                | Deno equivalent                                                              |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `Open`                         | omit `allowNet`                                                              |
| `Blocked`                      | `allowNet: []` (verify behaviour against docs; may need explicit deny flag)  |
| `Allowlist({ hosts })`         | `allowNet: hosts`                                                            |
| `Allowlist({ cidrs })`         | **reject** non-`/32`-`/128` ranges with `SandboxUnsupported` — Deno accepts only exact IP literals |

The CIDR rejection mirrors the existing pattern in
[`SandboxNetwork.ts`](../../packages/core/src/sandbox/SandboxNetwork.ts) —
we don't silently truncate.

### Secrets (`BoundSecret` → `secrets`)

```ts
secrets: Object.fromEntries(
  request.secrets.map((s) => [
    s.name,
    { hosts: s.hosts, value: Redacted.value(s.value) },
  ]),
)
```

`header` on `BoundSecret` is not supported by Deno's API — narrow it out
on the per-provider request shape (`DenoSandboxBoundSecret =
Omit<BoundSecret, "header">`) and reject at the upcast adapter (same
`rejectCustomHeader` pattern as Microsandbox).

### Timeouts (`Duration.Input` → `"5m"` / `"30s"`)

Deno accepts strings like `"5m"`, `"30s"`, or `"session"`. Convert:

```ts
const denoTimeout = (d: Duration.Input): string =>
  `${Math.ceil(Duration.toMillis(Duration.fromInputUnsafe(d)) / 1000)}s`
```

`Duration.Input` covers numbers (ms), strings, and `Duration` — same as
microsandbox.

### Volumes (`VolumeMount[]` → `Record<string, slug>`)

```ts
volumes: Object.fromEntries(
  request.volumes.map((v) => [v.mountPath, v.id]),
)
```

Deno's API has no readonly flag — if `v.readonly === true` we should
fail with `SandboxUnsupported` rather than silently mounting RW.

### Exec (`CommonExecRequest` → `sandbox.sh` / `sandbox.spawn`)

- `cmd: string` → `sandbox.sh\`${cmd}\`` (shell semantics).
- `cmd: string[]` → look at whether the SDK exposes a non-template exec
  taking an argv array. If not, build a shell-quoted string and route
  through `sh` (E2B-style). Confirm during implementation against the
  JSR doc.
- `cwd`, `env`, `stdin` → pass through the SDK's options object.
- `timeout` → not directly supported per-exec by the SDK; implement via
  `Effect.timeout` on the host side and `sandbox.kill()` on breach.

### Filesystem (`SandboxFilesystem` → `sandbox.fs.*`)

Straight passthrough. The SDK uses Deno's FS naming (`writeTextFile`,
`writeFile` for bytes, `readDir` for list). Map:

```
read    → fs.readFile      (Uint8Array)
write   → fs.writeFile     (Uint8Array | string)
remove  → fs.remove
mkdir   → fs.mkdir
list    → fs.readDir + map to FileEntry { path, kind }
exists  → fs.stat + catch NotFound → false
```

Walk Deno's `Deno.FileInfo` → `FileEntry.kind`:
`isFile → "file"`, `isDirectory → "directory"`, `isSymlink → "symlink"`,
otherwise `"other"`.

### Snapshot mismatch

`Sandbox.snapshots.create(from: SandboxInstance, name?: string)` does
**not** map onto Deno's "snapshot a volume" workflow — Deno requires a
volume slug, not a sandbox handle. Two options:

- **A (preferred)**: ship the `SandboxSnapshots` marker so read-side
  helpers (`listSnapshots`, `destroySnapshot`) compile against the
  layer, but have `snapshots.create` fail with `SandboxUnsupported`
  pointing the caller at the per-provider `DenoSandbox.snapshotVolume`
  escape hatch.
- **B**: omit the marker entirely — callers can't use the generic
  helpers but the per-provider surface exposes `snapshotVolume` directly.

Pick **A**. It matches how Microsandbox handles `ports.expose` — ship
the partial surface, fail the unsupported branch loudly. The per-provider
escape hatch lives on `DenoSandboxSandboxService`:

```ts
readonly snapshotVolume: (
  volumeId: VolumeId,
  slug?: string,
) => Effect.Effect<SnapshotId, SandboxError.SandboxError>
```

### Ports (`SandboxPortsApi` → `exposeHttp`)

```ts
ports: {
  expose: (instance, port) =>
    Effect.tryPromise({
      try: () => (instance as DenoBacked).sdk.exposeHttp({ port }),
      catch: mapExecError,
    }).pipe(Effect.map((url) => ({ url }))),
}
```

`(instance as DenoBacked).sdk` is the captured `DenoSandboxSdk` instance
— we'll need a private weakmap or closure-captured handle, same trick
Microsandbox uses (the adapter closes over `msb` per `adaptInstance`).

### Lifecycle

- `create` — `Sandbox.create(opts)` inside an `Effect.acquireRelease`,
  finalizer calls `sandbox.kill()` (Deno's auto-dispose works too, but
  going through `kill` is symmetric with the microsandbox adapter and
  doesn't rely on `Symbol.asyncDispose` semantics).
- `attach` — `Sandbox.connect({ id })`, finalizer is a no-op (detach,
  not destroy).
- `list` — `client.sandboxes.list()`. Map to `SandboxRef[]`.
- `destroy(id)` — `Sandbox.connect({ id })` then `.kill()`. Idempotent
  via `SandboxNotFound → void` like microsandbox's `destroyById`.

### Error mapping

Same shape as `mapCreateError` / `mapExecError` in
[`MicrosandboxSandbox.ts`](../../packages/providers/microsandbox/src/MicrosandboxSandbox.ts).
Specific Deno errors to map (check actual class names in SDK):

- `SandboxNotFoundError` → `SandboxNotFound`
- `SandboxQuotaError` (concurrency cap hit) → `SandboxQuotaExceeded`
- auth / 401 / 403 → `SandboxAuthFailed`
- 408 / timeout / `ExecTimeoutError` → `SandboxTimeout`
- everything else → `SandboxCreateFailed` / `SandboxExecFailed`

## Provider-narrowed request

```ts
export type DenoSandboxBoundSecret = Omit<BoundSecret, "header">

export type DenoSandboxCreateRequest = Omit<CommonCreateRequest, "secrets"> & {
  readonly secrets?: ReadonlyArray<DenoSandboxBoundSecret>
  readonly region?: "ams" | "ord"
  readonly memoryMb?: number              // 768..4096
  readonly labels?: Readonly<Record<string, string>>
  /** Auto-expose this port at boot; `sandbox.url` returns the preview URL. */
  readonly port?: number
}

export type DenoSandboxConfig = {
  readonly token?: Redacted.Redacted<string>  // overrides DENO_DEPLOY_TOKEN
  readonly defaultRegion?: "ams" | "ord"
}
```

`MicrosandboxSandbox.defaultImage` doesn't have a Deno analogue (no OCI
images), so the config stays minimal.

## File layout

```
packages/providers/deno-sandbox/
  package.json
  tsconfig.json
  tsdown.config.ts
  src/
    index.ts                   — re-export DenoSandboxSandbox
    DenoSandboxSandbox.ts      — Layer + adapter (mirror MicrosandboxSandbox.ts)
```

Package name: `@effect-uai/deno-sandbox`. Naming note — the cross-provider
service in core is already called `Sandbox`, so prefixing with `Deno` is
fine; the suffix `-sandbox` in the package name keeps it from clashing
with a future `@effect-uai/deno` runtime-specific package if we ever
need one (e.g. for Phase D).

`package.json` mirrors `microsandbox/package.json`:

```jsonc
{
  "name": "@effect-uai/deno-sandbox",
  "peerDependencies": {
    "@effect-uai/core": "workspace:>=0.5.0 <1",
    "effect": "4.0.0-beta.57",
    "@deno/sandbox": "^x.y.z"   // pin at implementation time
  }
}
```

## Integration test

Follow the [`integration-tests/sandbox-microsandbox/`](../../integration-tests/sandbox-microsandbox/)
pattern — **standalone**, excluded from the workspace, install via
`pnpm -C integration-tests/sandbox-deno install --ignore-workspace`.
This keeps the heavy `@deno/sandbox` native deps out of every contributor's
`node_modules`.

```
integration-tests/sandbox-deno/
  README.md          — auth setup (DENO_DEPLOY_TOKEN), run instructions
  package.json       — link: deps to ../../packages/core, ../../packages/providers/deno-sandbox
  tsconfig.json
  vitest.config.ts   — 120s testTimeout (sandbox boot)
  sandbox.test.ts
```

`pnpm-workspace.yaml` exclusion line:

```yaml
- "!integration-tests/sandbox-deno"
```

Root `package.json` script:

```
"test:integration:deno": "integration-tests/sandbox-deno/node_modules/.bin/vitest --root integration-tests/sandbox-deno run"
```

(Rename `test:integration` → `test:integration:microsandbox` at the same
time so the names stay symmetrical.)

Coverage to mirror the microsandbox test:

- Provision sandbox bound to an Effect scope (auto-kill on exit).
- `sh` exec with stdout capture and exit code.
- Streaming exec — stdout/stderr discrimination via tagged events.
- Filesystem write → read → list roundtrip.
- `Sandbox.list` reports the live sandbox before scope close.
- Scope close calls `kill()` (assert `Sandbox.list` no longer reports it).
- `exposeHttp` returns a URL (curl it for a spawned `deno serve`).
- `secrets` placeholder behaviour: write a script that `console.log`s
  `Deno.env.get("OPENAI_API_KEY")`, assert the in-VM value is the
  placeholder rather than the real value passed in.

Skipped without `DENO_DEPLOY_TOKEN` in env (Vitest `test.skipIf`).

## Recipe extension

Extend [`recipes-extras/sandbox-code-interpreter/`](../../recipes-extras/sandbox-code-interpreter/)
rather than spinning up a new recipe — the loop is identical, only the
sandbox layer differs. Add a `--sandbox <microsandbox|deno>` flag
alongside the existing `--provider <openai|anthropic|google>`:

```ts
const sandboxLayer = Match.value(sandbox).pipe(
  Match.when("microsandbox", () => MicrosandboxSandbox.layer({ defaultImage: "python:3.12" })),
  Match.when("deno", () => DenoSandboxSandbox.layer({})),
  Match.exhaustive,
)
```

This is the exact "same consumer code, swap the Layer" validation called
for in [`plans/sandbox.md`](../sandbox.md#phase-1--core--5-p1-providers).
Microsandbox boots from `python:3.12`; Deno has no custom-image path —
either point it at a pre-built snapshot containing Python, or `apt-get
install python3` inside the script.

Default the flag to `microsandbox` (no Deno Deploy account needed for the
first-run experience).

## Phasing

### Phase A — provider package

1. Scaffold `packages/providers/deno-sandbox/`. Copy
   `microsandbox/{package.json, tsconfig.json, tsdown.config.ts}` and rename.
2. Implement `DenoSandboxSandbox.ts` step by step against the
   `Microsandbox` template — image step, network step, secret step,
   exec adapter, FS adapter, snapshot escape hatch, port exposure.
3. Wire `Layer.mergeAll` registering the markers from
   [Capability markers shipped](#capability-markers-shipped).
4. Add to root `pnpm-workspace.yaml` and `tsconfig.json`.
5. `pnpm build && pnpm typecheck` from the root.

### Phase B — integration test

6. Scaffold `integration-tests/sandbox-deno/` with the standalone
   `--ignore-workspace` setup.
7. Add the test cases from [Integration test](#integration-test).
8. Add the `test:integration:deno` script. Document `DENO_DEPLOY_TOKEN`
   in the README. Run it locally with a real token.

### Phase C — recipe extension

9. Add the `--sandbox` flag to `recipes-extras/sandbox-code-interpreter/run.ts`.
10. Wire `link: ../../packages/providers/deno-sandbox` into the recipe's
    `package.json`.
11. Update the recipe's `README.md` so the "Run, fix, repeat" page
    documents the Deno option.

### Phase D (deferred) — validate effect-uai on the Deno runtime

The other half of "Deno sandboxes" the user mentioned: running the
**consuming** side under Deno itself. `@deno/sandbox` is published on
JSR for exactly that case, so a Deno-runtime recipe would round out
the story.

12. Add a `run-deno.ts` runner to the recipe (per
    [the runner-naming convention](../../recipes-extras/sandbox-code-interpreter/)).
13. Resolve any ESM / Node-builtin gaps in `@effect-uai/core` and the
    `responses` / provider packages — anything that hard-codes
    `node:fs` etc. needs an audit when invoked from `deno`.
14. Add a CI matrix entry that runs the existing test suite under
    `deno test --allow-all`. Validates the library actually works on
    Deno, not just that the sandbox provider does.

Treat Phase D as a separate planning doc once Phases A–C are merged.

## Open questions

- **Argv form**: does the SDK expose a non-template `exec` taking
  `argv: string[]`, or do we need to shell-quote and route through
  `sh`? Pin during Phase A by reading the JSR types.
- **Per-exec timeout**: SDK-level support, or pure host-side
  `Effect.timeout` + `kill`? Same — pin during Phase A.
- **`Blocked` network policy**: confirm whether `allowNet: []` actually
  blocks all egress, or whether it falls through to "no allowlist =
  open." If the latter, we need an explicit deny path.
- **`SandboxAuthFailed` mapping**: identify the precise SDK error class
  / shape for 401 responses so we don't lump them into `SandboxCreateFailed`.
