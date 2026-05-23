# sandbox-microsandbox — integration test

End-to-end test for `@effect-uai/microsandbox`. Boots a real microVM
via the local `msb` runtime, exercises exec / streaming / FS / list /
scope finalizer, and tears it down.

Excluded from the default `pnpm test` run.

This package is a **standalone**, deliberately kept out of the pnpm
workspace so its native deps (`microsandbox`, vitest's esbuild binary)
don't get pulled into the monorepo's root `node_modules`. Same pattern
as [`recipes-extras/`](../../recipes-extras/).

## Prerequisites

- Linux with KVM **or** macOS on Apple Silicon
- Node ≥ 22 (the SDK relies on `await using` / `Symbol.asyncDispose`)
- The workspace built once from the repo root: `pnpm build`
- `msb` runtime installed and running:

  ```bash
  npx microsandbox install   # one-time
  msb server start
  ```

## Run

```bash
# install once
pnpm -C integration-tests/sandbox-microsandbox install --ignore-workspace

# run from the repo root (uses this folder's local vitest)
pnpm test:integration
```

Override the OCI image via env:

```bash
MSB_IMAGE=python:3.12 pnpm test:integration
```

The unusual `--ignore-workspace` flag and `link:`-based deps are
explained in [`recipes-extras/README.md`](../../recipes-extras/README.md).

## What it covers

- Provisioning a sandbox bound to an Effect scope (auto-destroy on exit).
- Shell `exec` with stdout capture and exit code.
- Streaming `execStream` — stdout + stderr discrimination via tagged events.
- Filesystem write → read → list roundtrip.
- `Sandbox.list` reporting the live sandbox before scope close.
- Scope close calling `stop()` on the microVM (assert `Sandbox.list` no
  longer reports it).
- `exposePort` fails with `SandboxUnsupported`.

Not exercised here: secret injection, network policy, snapshots,
persistent volumes, pause/resume — add focused tests if/when needed.
