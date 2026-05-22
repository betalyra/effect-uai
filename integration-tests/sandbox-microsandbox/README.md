# sandbox-microsandbox — integration test

End-to-end test for `@effect-uai/microsandbox`. Boots a real microVM
via the local `msb` runtime, exercises exec / streaming / FS / list /
scope finalizer, and tears it down.

Excluded from the default `pnpm test` run.

## Prerequisites

- Linux with KVM **or** macOS on Apple Silicon
- Node ≥ 22 (the SDK relies on `await using` / `Symbol.asyncDispose`)
- `msb` runtime installed:

  ```bash
  npx microsandbox install
  ```

## Run

From the repo root:

```bash
pnpm test:integration
```

Or just this suite:

```bash
pnpm test:integration -- integration-tests/sandbox-microsandbox
```

Override the OCI image via env:

```bash
MSB_IMAGE=python:3.12 pnpm test:integration
```

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
