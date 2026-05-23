/**
 * Integration test for `@effect-uai/deno` — boots a real Firecracker
 * microVM on the Deno Deploy edge and exercises the adapter end-to-end.
 *
 * Excluded from the default `pnpm test` run; run from the repo root via
 * `pnpm test:integration:deno`.
 *
 * Requires `DENO_API_KEY` (a Deno Deploy access token) in env.
 * Organization tokens (`ddo_…`) work on their own; personal tokens
 * (`ddp_…`) additionally need `DENO_DEPLOY_ORG`. Without `DENO_API_KEY`
 * the suite is skipped — safe to leave wired into CI.
 */
import { Array as Arr, Effect, Redacted, Result, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Sandbox from "@effect-uai/core/Sandbox"
import * as Network from "@effect-uai/core/SandboxNetwork"
import * as SandboxError from "@effect-uai/core/SandboxError"
import {
  DenoSandbox,
  layer as denoLayer,
  type DenoSandboxBoundSecret,
} from "@effect-uai/deno/DenoSandbox"

const TOKEN = process.env.DENO_API_KEY
const HAS_TOKEN = TOKEN !== undefined

const REGION = (process.env.DENO_SANDBOX_REGION ?? "ord") as "ord" | "ams"

const live = denoLayer({
  ...(TOKEN === undefined ? {} : { token: Redacted.make(TOKEN) }),
  ...(process.env.DENO_DEPLOY_ORG === undefined ? {} : { org: process.env.DENO_DEPLOY_ORG }),
  defaultRegion: REGION,
})

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

// Skip the whole suite when no token is configured — the SDK throws
// `MissingTokenError` on `Sandbox.create` otherwise.
describe.skipIf(!HAS_TOKEN)("DenoSandbox (live Deno Deploy microVM)", () => {
  // -------------------------------------------------------------------------
  // Happy path: create → exec → stream → fs → list → scope-close
  // -------------------------------------------------------------------------

  it("creates → exec → fs roundtrip → scope finalizer destroys", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({
        env: { GREETING: "world" },
      })

      // Sync exec — `cmd: string` routes through `bash -c`.
      const echo = yield* sb.exec({ cmd: "echo hello $GREETING" })
      expect(echo.exitCode).toBe(0)
      expect(echo.stdout.trim()).toBe("hello world")

      // Streaming exec → drain
      const events = yield* Stream.runCollect(
        sb.execStream({ cmd: ["bash", "-c", "echo line-1; echo line-2 1>&2"] }),
      )
      const stdoutChunks = Arr.filterMap(events, (e) =>
        e._tag === "Stdout" ? Result.succeed(decode(e.chunk)) : Result.failVoid,
      )
      const stderrChunks = Arr.filterMap(events, (e) =>
        e._tag === "Stderr" ? Result.succeed(decode(e.chunk)) : Result.failVoid,
      )
      const completes = Arr.filter(events, (e) => e._tag === "Complete")
      expect(stdoutChunks.join("")).toContain("line-1")
      expect(stderrChunks.join("")).toContain("line-2")
      expect(completes).toHaveLength(1)

      // Filesystem roundtrip
      yield* sb.files.write("/tmp/effect-uai.txt", "from the host")
      const back = yield* sb.files.read("/tmp/effect-uai.txt")
      expect(decode(back)).toBe("from the host")

      const listing = yield* sb.files.list("/tmp")
      expect(listing.map((e) => e.path)).toContain("effect-uai.txt")

      // Visible in `Sandbox.list` while live
      const inventory = yield* Sandbox.list
      expect(inventory.map((s) => s.id)).toContain(sb.id)

      return sb.id
    })

    const id = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))

    // After scope close, the sandbox should be gone from the list.
    const after = await Effect.runPromise(Sandbox.list.pipe(Effect.provide(live)))
    expect(after.map((s) => s.id)).not.toContain(id)
  })

  // -------------------------------------------------------------------------
  // Code execution — write a Deno script, run it, parse JSON output
  // -------------------------------------------------------------------------

  it("runs a Deno TS script and returns a parsed JSON result", async () => {
    const source = `
type Item = { readonly id: number; readonly name: string }
const inventory: ReadonlyArray<Item> = [
  { id: 1, name: "alpha" },
  { id: 2, name: "beta" },
]
const summary = {
  count: inventory.length,
  names: inventory.map((i) => i.name),
}
console.log(JSON.stringify(summary))
`

    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({})
      yield* sb.files.write("/tmp/script.ts", source)
      const result = yield* sb.exec({ cmd: ["deno", "run", "/tmp/script.ts"] })

      expect(result.exitCode).toBe(0)
      return JSON.parse(result.stdout.trim()) as {
        count: number
        names: ReadonlyArray<string>
      }
    })

    const parsed = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(parsed.count).toBe(2)
    expect(parsed.names).toEqual(["alpha", "beta"])
  })

  // -------------------------------------------------------------------------
  // Secret injection — in-VM env is a placeholder, never the real value
  // -------------------------------------------------------------------------

  it("secret injection: guest never sees the real value", async () => {
    const REAL_SECRET = "sk-real-secret-must-never-enter-the-guest"
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({
        secrets: [
          {
            name: "OPENAI_API_KEY",
            value: Redacted.make(REAL_SECRET),
            hosts: ["api.openai.com"],
          },
        ],
      })

      // Deno docs: "Inside the sandbox, secrets appear as placeholders
      // rather than real values." We only assert the real value never
      // leaks; the exact placeholder format is provider-internal.
      const result = yield* sb.exec({ cmd: 'printf "%s" "$OPENAI_API_KEY"' })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain(REAL_SECRET)
      expect(result.stdout.length).toBeGreaterThan(0)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
  })

  // -------------------------------------------------------------------------
  // Contracts on `exec` / `spawn`
  // -------------------------------------------------------------------------

  it("non-zero exit code is an ExecResult, not a failed Effect", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({})
      return yield* sb.exec({ cmd: "exit 7" })
    })

    const result = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(result.exitCode).toBe(7)
    expect(result.stdout).toBe("")
  })

  it("stdin is delivered to the process", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({})
      return yield* sb.exec({ cmd: ["cat"], stdin: "hello stdin" })
    })

    const result = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("hello stdin")
  })

  it("exec: env and cwd are delivered to the process", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({})
      const result = yield* sb.exec({
        cmd: "echo $FOO at $(pwd)",
        env: { FOO: "bar" },
        cwd: "/tmp",
      })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("bar at /tmp")
    })
    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
  })

  it("execStream: Complete is the terminal event", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({})
      const events = yield* Stream.runCollect(
        sb.execStream({ cmd: ["bash", "-c", "echo a; echo b 1>&2; exit 3"] }),
      )
      const list = Array.from(events)
      const completeIdx = list.findIndex((e) => e._tag === "Complete")
      expect(completeIdx).toBe(list.length - 1)
      const complete = list[completeIdx]!
      if (complete._tag === "Complete") {
        expect(complete.exitCode).toBe(3)
      }
    })
    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
  })

  it("spawn: Stream<Uint8Array> stdin is piped into the process", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({})
      const stdin = Stream.fromIterable([
        new TextEncoder().encode("line-1\n"),
        new TextEncoder().encode("line-2\n"),
        new TextEncoder().encode("line-3\n"),
      ])
      const handle = yield* sb.spawn({ cmd: ["cat"], stdin })
      const events = yield* Stream.runCollect(handle.events)
      const stdout = Arr.filterMap(events, (e) =>
        e._tag === "Stdout" ? Result.succeed(decode(e.chunk)) : Result.failVoid,
      ).join("")
      expect(stdout).toBe("line-1\nline-2\nline-3\n")
    })
    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
  })

  // -------------------------------------------------------------------------
  // Capability gating: BoundSecret.header (row B + row D)
  // -------------------------------------------------------------------------

  it("rejects BoundSecret.header via generic Sandbox surface (row D)", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({
        secrets: [
          {
            name: "MY_TOKEN",
            value: Redacted.make("xyz"),
            hosts: ["api.example.com"],
            // Deno doesn't accept arbitrary headers → SandboxUnsupported
            header: "X-Custom: %s",
          },
        ],
      })
      return sb.id
    })

    const exit = await Effect.runPromiseExit(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const s = JSON.stringify(exit.cause)
      expect(s).toContain("SandboxUnsupported")
      expect(s).toContain("BoundSecret.header")
    }
  })

  it("DenoSandboxBoundSecret omits `header` at the type level (row B)", () => {
    const bad: DenoSandboxBoundSecret = {
      name: "MY_TOKEN",
      value: Redacted.make("xyz"),
      hosts: ["api.example.com"],
      // @ts-expect-error - header is omitted from DenoSandboxBoundSecret
      header: "X-Custom: %s",
    }
    expect(bad.name).toBe("MY_TOKEN")
  })

  // -------------------------------------------------------------------------
  // Decode-time rejections — features Deno doesn't support
  // -------------------------------------------------------------------------

  it("rejects ImageRef.Registry — Deno doesn't accept OCI refs", async () => {
    const program = Sandbox.create({
      image: Sandbox.ImageRef.Registry({ ref: "python:3.12" }),
    })
    const exit = await Effect.runPromiseExit(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const s = JSON.stringify(exit.cause)
      expect(s).toContain("SandboxUnsupported")
      expect(s).toContain("image.registry")
    }
  })

  it("rejects ImageRef.Dockerfile — Deno doesn't accept Dockerfiles", async () => {
    const program = Sandbox.create({
      image: Sandbox.ImageRef.Dockerfile({ contents: "FROM alpine\nRUN echo hi" }),
    })
    const exit = await Effect.runPromiseExit(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const s = JSON.stringify(exit.cause)
      expect(s).toContain("SandboxUnsupported")
      expect(s).toContain("image.dockerfile")
    }
  })

  it("rejects CIDR ranges in NetworkPolicy.Allowlist", async () => {
    const program = Sandbox.create({
      network: Network.allow({ hosts: ["api.openai.com"], cidrs: ["10.0.0.0/8"] }),
    })
    const exit = await Effect.runPromiseExit(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const s = JSON.stringify(exit.cause)
      expect(s).toContain("SandboxUnsupported")
      expect(s).toContain("network.cidrs")
    }
  })

  // -------------------------------------------------------------------------
  // Snapshots — generic `Sandbox.snapshots.create(from)` is unsupported;
  // use the per-provider `DenoSandbox.snapshotVolume` escape hatch.
  // -------------------------------------------------------------------------

  it("generic snapshots.create fails with SandboxUnsupported (use snapshotVolume)", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({})
      const denoSvc = yield* DenoSandbox.asEffect()
      // Direct sub-API call (not the gated free helper) so we can
      // observe the runtime failure.
      return yield* denoSvc.snapshots.create(sb, "ignored")
    })

    const exit = await Effect.runPromiseExit(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const s = JSON.stringify(exit.cause)
      expect(s).toContain("SandboxUnsupported")
      expect(s).toContain("snapshots.create")
    }
  })

  // -------------------------------------------------------------------------
  // Port exposure — start a tiny HTTP server in-VM, expose, curl from host
  // -------------------------------------------------------------------------

  it("exposePort returns a public URL that reaches the in-VM server", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({})

      // Write a one-liner Deno server inside the VM, spawn it.
      yield* sb.files.write(
        "/tmp/server.ts",
        `Deno.serve({ port: 8000 }, () => new Response("hello from sandbox"))`,
      )
      yield* sb.spawn({ cmd: ["deno", "run", "-NE", "/tmp/server.ts"] })

      // Give the server a beat to bind.
      yield* Effect.sleep("1 second")

      const { url } = yield* Sandbox.exposePort(sb, 8000)
      expect(url).toMatch(/^https?:\/\//)

      // Fetch from the host — confirms the preview URL is live.
      const text = yield* Effect.tryPromise({
        try: () => fetch(url).then((r) => r.text()),
        catch: (e) =>
          new SandboxError.SandboxExecFailed({
            provider: "deno",
            raw: e,
            reason: e instanceof Error ? e.message : "fetch failed",
          }),
      })
      expect(text).toBe("hello from sandbox")
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
  })

  // -------------------------------------------------------------------------
  // destroy(id) idempotency — second call is a no-op
  // -------------------------------------------------------------------------

  it("destroy(id) is idempotent — second call is a no-op", async () => {
    // Phase 1: create + capture id under a fresh scope.
    const id = await Effect.runPromise(
      Effect.gen(function* () {
        const sb = yield* Sandbox.create({})
        // Touch a file so the SDK actually finalizes provisioning.
        yield* sb.exec({ cmd: "true" })
        return sb.id
      }).pipe(Effect.scoped, Effect.provide(live)),
    )

    const destroy = Sandbox.destroy(id).pipe(Effect.provide(live))
    // Sandbox already killed by scope close in phase 1 — both calls
    // should succeed silently.
    await Effect.runPromise(destroy)
    await Effect.runPromise(destroy)
  })
})
