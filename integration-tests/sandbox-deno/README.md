# sandbox-deno — integration test

End-to-end test for `@effect-uai/deno`. Boots a real Firecracker
microVM on the Deno Deploy edge via `@deno/sandbox`, exercises exec /
streaming / FS / list / secrets / port exposure / scope finalizer, and
tears it down.

Excluded from the default `pnpm test` run.

This package is a **standalone**, deliberately kept out of the pnpm
workspace so its native deps (`@deno/sandbox`'s `ws` + dnt-bundled
runtime, vitest's esbuild binary) don't get pulled into the monorepo's
root `node_modules`. Same pattern as
[`sandbox-microsandbox/`](../sandbox-microsandbox/).

## Prerequisites

- Node ≥ 22 (the SDK uses `await using` / `Symbol.asyncDispose`)
- The workspace built once from the repo root: `pnpm build`
- A Deno Deploy account at <https://console.deno.com>
- An access token from **Settings → Organization tokens**, exported as
  `DENO_API_KEY`:

  ```bash
  export DENO_API_KEY=ddo_your_organization_token
  ```

  Organization tokens (`ddo_…`) work on their own. Personal tokens
  (`ddp_…`) additionally need `DENO_DEPLOY_ORG=<your-org-slug>`.

## Run

```bash
# install once
pnpm -C integration-tests/sandbox-deno install --ignore-workspace

# run from the repo root (uses this folder's local vitest)
pnpm test:integration:deno
```

Override the region via env (default `ord`; `ams` also available):

```bash
DENO_SANDBOX_REGION=ams pnpm test:integration:deno
```

The unusual `--ignore-workspace` flag and `link:`-based deps are
explained in [`recipes-extras/README.md`](../../recipes-extras/README.md).

## What it covers

- Provisioning a sandbox bound to an Effect scope (auto-kill on exit).
- Shell `exec` with stdout capture, exit code, env, cwd.
- Streaming `execStream` — stdout/stderr discrimination via tagged
  events, `Complete` is terminal.
- One-shot string stdin + `Stream<Uint8Array>` stdin into `spawn`.
- Filesystem write → read → list roundtrip.
- `Sandbox.list` reporting the live sandbox before scope close.
- Scope close calling `kill()` (assert `Sandbox.list` no longer reports
  it).
- Running a Deno TS script and parsing its JSON output.
- Secret injection: real value never visible to in-VM env.
- `BoundSecret.header` rejected at runtime via generic surface (row D)
  - omitted from `DenoSandboxBoundSecret` at the type level (row B).
- Decode-time rejections: `ImageRef.Registry`, `ImageRef.Dockerfile`,
  `NetworkPolicy.Allowlist({ cidrs })`.
- Generic `Sandbox.snapshots.create(from)` fails with
  `SandboxUnsupported` (Deno snapshots are volume-derived — use
  `DenoSandbox.snapshotVolume` instead).
- `exposeHttp` — write a Deno server in-VM, `spawn` it, fetch the
  preview URL from the host.
- `Sandbox.destroy(id)` is idempotent.

Not exercised here: volume create / mount / snapshot roundtrip
(requires `ord` region quota), the `attach` flow against a longer-lived
sandbox, network allowlist enforcement on outbound HTTPS. Add focused
tests when the surface needs them.
