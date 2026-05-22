/**
 * Integration test for `@effect-uai/microsandbox` — boots a real
 * microVM via the local `msb` runtime and exercises the adapter
 * end-to-end. Excluded from the default `pnpm test` run; run via
 * `pnpm test:integration`.
 *
 * Requires `msb` installed on the host (`npx microsandbox install`)
 * and Linux/KVM or macOS/Apple-Silicon hardware support.
 */
import { Array as Arr, Effect, Redacted, Result, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Sandbox from "@effect-uai/core/Sandbox"
import {
  layer as microsandboxLayer,
  MicrosandboxSandbox,
  type MicrosandboxBoundSecret,
} from "@effect-uai/microsandbox/MicrosandboxSandbox"

const IMAGE = process.env.MSB_IMAGE ?? "alpine"

const live = microsandboxLayer({ defaultImage: IMAGE })

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

// Shared snippet for counting processes by name inside an Alpine guest.
// BusyBox `pgrep` doesn't support `-c`; pipe to `wc -l`. When pgrep has
// no matches it exits 1 with empty stdout, and `wc -l` on empty input
// prints `0` (possibly with leading whitespace — caller `.trim()`s).
const pgrepCount = (name: string) => `pgrep ${name} 2>/dev/null | wc -l`

describe("MicrosandboxSandbox (live microVM)", () => {
  it("creates → exec → fs roundtrip → scope finalizer destroys", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({
        image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
        env: { GREETING: "world" },
      })

      // Sync exec
      const echo = yield* sb.exec({
        cmd: ["sh", "-c", "echo hello $GREETING"],
      })
      expect(echo.exitCode).toBe(0)
      expect(echo.stdout.trim()).toBe("hello world")

      // Streaming exec → drain
      const events = yield* Stream.runCollect(
        sb.execStream({ cmd: ["sh", "-c", "echo line-1; echo line-2 1>&2"] }),
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
      expect(listing.map((e) => e.path)).toContain("/tmp/effect-uai.txt")

      // Visible in `Sandbox.list` while live
      const inventory = yield* Sandbox.list
      expect(inventory.map((s) => s.id)).toContain(sb.id)

      return sb.id
    })

    const id = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))

    // After scope close, the sandbox should be gone.
    const after = await Effect.runPromise(Sandbox.list.pipe(Effect.provide(live)))
    expect(after.map((s) => s.id)).not.toContain(id)
  }, 60_000) // microVM boot + image pull on first run can take several seconds

  it("runs model-style TypeScript code and returns a parsed JSON result", async () => {
    // Native Node TS stripping — no tsx / ts-node install needed.
    const NODE_IMAGE = process.env.MSB_NODE_IMAGE ?? "node:22-alpine"

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
process.stdout.write(JSON.stringify(summary))
`

    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({
        image: Sandbox.ImageRef.Registry({ ref: NODE_IMAGE }),
      })

      yield* sb.files.write("/tmp/script.ts", source)
      const result = yield* sb.exec({
        cmd: ["node", "--experimental-strip-types", "--no-warnings", "/tmp/script.ts"],
      })

      expect(result.exitCode).toBe(0)
      return JSON.parse(result.stdout) as {
        count: number
        names: ReadonlyArray<string>
      }
    })

    const parsed = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(parsed.count).toBe(2)
    expect(parsed.names).toEqual(["alpha", "beta"])
  }, 120_000)

  it("secret injection: guest sees the placeholder, not the real value", async () => {
    const REAL_SECRET = "sk-real-secret-must-never-enter-the-guest"
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({
        image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
        secrets: [
          {
            name: "OPENAI_API_KEY",
            value: Redacted.make(REAL_SECRET),
            hosts: ["api.openai.com"],
          },
        ],
      })

      // Microsandbox's placeholder convention is `$MSB_<NAME>`. The
      // real value only materializes on outbound HTTPS to the
      // allowed host — never in env, never in stdout.
      const result = yield* sb.exec({
        cmd: ["sh", "-c", 'printf "%s" "$OPENAI_API_KEY"'],
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain(REAL_SECRET)
      expect(result.stdout).toBe("$MSB_OPENAI_API_KEY")
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
  }, 60_000)

  // -------------------------------------------------------------------------
  // Contracts on `exec` and friends
  // -------------------------------------------------------------------------

  it("non-zero exit code is an ExecResult, not a failed Effect", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({
        image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
      })
      return yield* sb.exec({ cmd: ["sh", "-c", "exit 7"] })
    })

    const result = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(result.exitCode).toBe(7)
    expect(result.stdout).toBe("")
  }, 60_000)

  it("stdin is delivered to the process", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({
        image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
      })
      return yield* sb.exec({ cmd: ["cat"], stdin: "hello stdin" })
    })

    const result = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe("hello stdin")
  }, 60_000)

  it("spawn process is killed when its scope closes", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({
        image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
      })

      // Sub-scope spawns sleep; its finalizer must kill the process.
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* sb.spawn({ cmd: ["sleep", "60"] })
          // Give the process a beat to start.
          yield* Effect.sleep("300 millis")
          const inside = yield* sb.exec({
            cmd: ["sh", "-c", pgrepCount("sleep")],
          })
          expect(Number(inside.stdout.trim())).toBeGreaterThan(0)
        }),
      )

      // After scope close, the kill should have landed.
      yield* Effect.sleep("500 millis")
      const after = yield* sb.exec({ cmd: ["sh", "-c", pgrepCount("sleep")] })
      expect(Number(after.stdout.trim())).toBe(0)
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
  }, 60_000)

  // -------------------------------------------------------------------------
  // Capability gating: BoundSecret.header
  // -------------------------------------------------------------------------

  it("rejects BoundSecret.header via generic Sandbox surface (row D)", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({
        image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
        secrets: [
          {
            name: "MY_TOKEN",
            value: Redacted.make("xyz"),
            hosts: ["api.example.com"],
            // microsandbox doesn't accept arbitrary headers → SandboxUnsupported
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
  }, 60_000)

  it("MicrosandboxBoundSecret omits `header` at the type level (row B)", () => {
    // Compile-time only: the narrowed surface does not carry `header`.
    // The `@ts-expect-error` makes this test fail if the narrowing breaks.
    const bad: MicrosandboxBoundSecret = {
      name: "MY_TOKEN",
      value: Redacted.make("xyz"),
      hosts: ["api.example.com"],
      // @ts-expect-error - header is omitted from MicrosandboxBoundSecret
      header: "X-Custom: %s",
    }
    expect(bad.name).toBe("MY_TOKEN")
  })

  // -------------------------------------------------------------------------
  // Volumes
  // -------------------------------------------------------------------------

  it("volumes: data persists across sandboxes mounting the same volume", async () => {
    const volName = `eff-uai-vol-${Date.now()}`
    const program = Effect.gen(function* () {
      const volId = yield* Sandbox.createVolume(volName)

      // Volume must outlive both sandboxes; destroy it on scope close.
      yield* Effect.addFinalizer(() => Effect.orDie(Sandbox.destroyVolume(volId)))

      // Writer
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sb = yield* Sandbox.create({
            image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
            volumes: [{ id: volId, mountPath: "/data" }],
          })
          const wrote = yield* sb.exec({
            cmd: ["sh", "-c", "echo persisted > /data/marker.txt"],
          })
          expect(wrote.exitCode).toBe(0)
        }),
      )

      // Reader — mounts the same volume read-only
      const read = yield* Effect.scoped(
        Effect.gen(function* () {
          const sb = yield* Sandbox.create({
            image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
            volumes: [{ id: volId, mountPath: "/data", readonly: true }],
          })
          return yield* sb.exec({ cmd: ["cat", "/data/marker.txt"] })
        }),
      )

      expect(read.exitCode).toBe(0)
      expect(read.stdout.trim()).toBe("persisted")
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
  }, 120_000)

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  it("snapshots: boot from snapshot preserves filesystem state", async () => {
    const program = Effect.gen(function* () {
      // Phase 1: source sandbox writes a marker, then we snapshot it.
      // The adapter stops the source before taking the snapshot (per
      // microsandbox's "must be stopped" requirement), so further exec
      // on `source` would fail.
      const snapshotId = yield* Effect.scoped(
        Effect.gen(function* () {
          const source = yield* Sandbox.create({
            image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
          })
          yield* source.files.write("/srv/marker.txt", "preserved-by-snapshot")
          return yield* Sandbox.snapshot(source, `eff-uai-snap-${Date.now()}`)
        }),
      )

      // Cleanup: destroy the snapshot when this test scope ends.
      yield* Effect.addFinalizer(() => Effect.orDie(Sandbox.destroySnapshot(snapshotId)))

      // Phase 2: boot a fresh sandbox from the snapshot, assert state.
      const text = yield* Effect.scoped(
        Effect.gen(function* () {
          const restored = yield* Sandbox.create({
            image: Sandbox.ImageRef.Snapshot({ id: snapshotId }),
          })
          const bytes = yield* restored.files.read("/srv/marker.txt")
          return decode(bytes)
        }),
      )

      expect(text).toBe("preserved-by-snapshot")
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
  }, 180_000)

  // -------------------------------------------------------------------------
  // Detached + attach
  // -------------------------------------------------------------------------

  it("detached sandbox survives scope close and is reachable via attach", async () => {
    const name = `eff-uai-detached-${Date.now()}`

    // Phase 1: create detached (scope close should NOT destroy)
    await Effect.runPromise(
      Effect.gen(function* () {
        const msb = yield* MicrosandboxSandbox.asEffect()
        const sb = yield* msb.create({
          image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
          name,
          detached: true,
        })
        yield* sb.files.write("/tmp/marker.txt", "from-phase-1")
      }).pipe(Effect.scoped, Effect.provide(live)),
    )

    try {
      // Phase 2: attach in a fresh scope and read the marker
      const text = await Effect.runPromise(
        Effect.gen(function* () {
          const sb = yield* Sandbox.attach(name as Sandbox.SandboxId)
          const bytes = yield* sb.files.read("/tmp/marker.txt")
          return decode(bytes)
        }).pipe(Effect.scoped, Effect.provide(live)),
      )
      expect(text).toBe("from-phase-1")
    } finally {
      // Phase 3: explicit cleanup (attach's finalizer doesn't destroy)
      await Effect.runPromise(Sandbox.destroy(name as Sandbox.SandboxId).pipe(Effect.provide(live)))
    }
  }, 120_000)

  // -------------------------------------------------------------------------
  // Network policy + replace + timeoutMs
  // -------------------------------------------------------------------------

  it("network policy: non-allowlisted hosts are unreachable", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({
        image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
        network: Sandbox.NetworkPolicy.Allowlist({ hosts: ["api.openai.com"] }),
      })
      // Try to reach a non-allowed host — should fail at the VM boundary.
      // `|| echo BLOCKED` makes the shell exit cleanly with a known marker.
      const result = yield* sb.exec({
        cmd: ["sh", "-c", "wget -q -T 5 -O - https://example.com 2>&1 || echo BLOCKED"],
      })
      return result.stdout
    })

    const out = await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(out).toContain("BLOCKED")
  }, 120_000)

  it("replace: second create with same name fails; replace:true succeeds", async () => {
    const name = `eff-uai-replace-${Date.now()}`
    const program = Effect.gen(function* () {
      const msb = yield* MicrosandboxSandbox.asEffect()

      // First sandbox stays alive in the outer scope.
      yield* msb.create({
        image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
        name,
      })

      // Second create with same name, no replace → SandboxAlreadyExists
      const fail = yield* msb
        .create({
          image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
          name,
        })
        .pipe(Effect.scoped, Effect.exit)
      expect(fail._tag).toBe("Failure")
      if (fail._tag === "Failure") {
        expect(JSON.stringify(fail.cause)).toContain("SandboxAlreadyExists")
      }

      // Third create with replace: true → succeeds (stops + replaces the first)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const replaced = yield* msb.create({
            image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
            name,
            replace: true,
          })
          const ok = yield* replaced.exec({ cmd: ["true"] })
          expect(ok.exitCode).toBe(0)
        }),
      )
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(live)))
  }, 180_000)

  it("timeoutMs aborts a long-running exec with SandboxTimeout", async () => {
    const program = Effect.gen(function* () {
      const sb = yield* Sandbox.create({
        image: Sandbox.ImageRef.Registry({ ref: IMAGE }),
      })
      return yield* sb.exec({ cmd: ["sleep", "30"], timeoutMs: 500 })
    })

    const exit = await Effect.runPromiseExit(program.pipe(Effect.scoped, Effect.provide(live)))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(JSON.stringify(exit.cause)).toContain("SandboxTimeout")
    }
  }, 60_000)
})
