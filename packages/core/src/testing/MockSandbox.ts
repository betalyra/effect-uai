import { Array as Arr, Data, Effect, Layer, Ref, Stream } from "effect"
import {
  ExecEvent,
  Sandbox,
  SandboxCustomImage,
  SandboxHostnameAllowlist,
  SandboxKernelSession,
  SandboxPauseResume,
  SandboxPortExposure,
  SandboxPty,
  SandboxSecretInjection,
  SandboxSnapshots,
  SandboxVolumes,
  type CommonCreateRequest,
  type CommonExecRequest,
  type ExecResult,
  type FileEntry,
  type ProcessHandle,
  type SandboxId,
  type SandboxInstance,
  type SandboxRef,
  type SandboxService,
  type SnapshotId,
  type VolumeId,
} from "../sandbox/Sandbox.js"
import * as SandboxError from "../sandbox/SandboxError.js"

// ---------------------------------------------------------------------------
// Call log
// ---------------------------------------------------------------------------

/**
 * One entry per side-effecting method call. Tests filter via
 * `Call.$is(...)` / `Call.$match`.
 */
export type Call = Data.TaggedEnum<{
  Create: { readonly request: CommonCreateRequest }
  Attach: { readonly id: SandboxId }
  Destroy: { readonly id: SandboxId }
  Exec: { readonly id: SandboxId; readonly request: CommonExecRequest }
  ExecStream: { readonly id: SandboxId; readonly request: CommonExecRequest }
  Spawn: { readonly id: SandboxId; readonly request: CommonExecRequest }
  FileRead: { readonly id: SandboxId; readonly path: string }
  FileWrite: {
    readonly id: SandboxId
    readonly path: string
    readonly contents: Uint8Array | string
  }
  FileRemove: { readonly id: SandboxId; readonly path: string }
  FileMkdir: { readonly id: SandboxId; readonly path: string }
  FileList: { readonly id: SandboxId; readonly path: string }
  FileExists: { readonly id: SandboxId; readonly path: string }
  ExposePort: { readonly id: SandboxId; readonly port: number }
  SnapshotCreate: { readonly id: SandboxId; readonly name?: string }
  SnapshotDestroy: { readonly id: SnapshotId }
  VolumeCreate: { readonly name: string; readonly quotaBytes?: number }
  VolumeDestroy: { readonly id: VolumeId }
}>

export const Call = Data.taggedEnum<Call>()

export type MockSandboxRecorder = {
  readonly calls: ReadonlyArray<Call>
}

// ---------------------------------------------------------------------------
// Script
// ---------------------------------------------------------------------------

/**
 * What this mock should hand back per call. Each method has its own
 * scripted queue and a sensible default when the queue is empty.
 * The filesystem is an in-memory mutable map seeded by `files`.
 */
export type MockSandboxScript = {
  readonly id?: string
  readonly execs?: ReadonlyArray<ExecResult>
  readonly streams?: ReadonlyArray<ReadonlyArray<ExecEvent>>
  readonly spawns?: ReadonlyArray<ProcessHandle>
  readonly files?: Readonly<Record<string, Uint8Array | string>>
  readonly sandboxes?: ReadonlyArray<SandboxRef>
  readonly snapshots?: ReadonlyArray<{ readonly id: SnapshotId; readonly name?: string }>
  readonly volumes?: ReadonlyArray<{ readonly id: VolumeId; readonly name: string }>
  readonly portUrl?: (port: number) => string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultExec: ExecResult = { exitCode: 0, stdout: "", stderr: "", durationMs: 0 }

const toBytes = (contents: Uint8Array | string) =>
  typeof contents === "string" ? new TextEncoder().encode(contents) : contents

const seedFs = (files: MockSandboxScript["files"]) =>
  new Map(Object.entries(files ?? {}).map(([k, v]) => [k, toBytes(v)]))

const exhausted = (method: string, scripted: number, attempt: number) =>
  new SandboxError.SandboxInvalidRequest({
    provider: "mock",
    reason: `MockSandbox exhausted: ${scripted} ${method}(s) scripted, but call ${attempt} was made`,
  })

const consume = <A>(
  cursor: Ref.Ref<number>,
  scripted: ReadonlyArray<A>,
  onMiss: (attempt: number) => Effect.Effect<A, SandboxError.SandboxError>,
) =>
  Ref.getAndUpdate(cursor, (n) => n + 1).pipe(
    Effect.flatMap((i) => (i < scripted.length ? Effect.succeed(scripted[i]!) : onMiss(i + 1))),
  )

// ---------------------------------------------------------------------------
// Service builder
// ---------------------------------------------------------------------------

const buildInstance = (
  id: SandboxId,
  script: MockSandboxScript,
  fs: Ref.Ref<Map<string, Uint8Array>>,
  execCursor: Ref.Ref<number>,
  streamCursor: Ref.Ref<number>,
  spawnCursor: Ref.Ref<number>,
  record: (call: Call) => Effect.Effect<void>,
): SandboxInstance => ({
  id,

  exec: (request) =>
    record(Call.Exec({ id, request })).pipe(
      Effect.andThen(consume(execCursor, script.execs ?? [], () => Effect.succeed(defaultExec))),
    ),

  execStream: (request) =>
    Stream.unwrap(
      record(Call.ExecStream({ id, request })).pipe(
        Effect.andThen(
          consume(streamCursor, script.streams ?? [], () =>
            Effect.succeed<ReadonlyArray<ExecEvent>>([
              ExecEvent.Complete({ exitCode: 0, durationMs: 0 }),
            ]),
          ),
        ),
        Effect.map(
          (events) =>
            Stream.fromIterable(events) as Stream.Stream<ExecEvent, SandboxError.SandboxError>,
        ),
      ),
    ),

  spawn: (request) =>
    record(Call.Spawn({ id, request })).pipe(
      Effect.andThen(
        consume(spawnCursor, script.spawns ?? [], (n) =>
          Effect.fail(exhausted("spawn", (script.spawns ?? []).length, n)),
        ),
      ),
      Effect.tap((handle) => Effect.addFinalizer(() => Effect.orDie(handle.kill))),
    ),

  files: {
    read: (path) =>
      record(Call.FileRead({ id, path })).pipe(
        Effect.andThen(Ref.get(fs)),
        Effect.flatMap((map) =>
          map.has(path)
            ? Effect.succeed(map.get(path)!)
            : Effect.fail(
                new SandboxError.SandboxExecFailed({
                  provider: "mock",
                  reason: `ENOENT: ${path}`,
                  raw: undefined,
                }),
              ),
        ),
      ),

    write: (path, contents) =>
      record(Call.FileWrite({ id, path, contents })).pipe(
        Effect.andThen(Ref.update(fs, (m) => new Map(m).set(path, toBytes(contents)))),
      ),

    remove: (path) =>
      record(Call.FileRemove({ id, path })).pipe(
        Effect.andThen(
          Ref.update(fs, (m) => {
            const next = new Map(m)
            next.delete(path)
            return next
          }),
        ),
      ),

    mkdir: (path) => record(Call.FileMkdir({ id, path })),

    list: (path) =>
      record(Call.FileList({ id, path })).pipe(
        Effect.andThen(Ref.get(fs)),
        Effect.map((map) => {
          const prefix = path.endsWith("/") ? path : `${path}/`
          const out: Array<FileEntry> = []
          for (const k of map.keys()) {
            if (k.startsWith(prefix)) out.push({ path: k, kind: "file" })
          }
          return out
        }),
      ),

    exists: (path) =>
      record(Call.FileExists({ id, path })).pipe(
        Effect.andThen(Ref.get(fs)),
        Effect.map((map) => map.has(path)),
      ),
  },
})

const buildService = (
  script: MockSandboxScript,
  record: (call: Call) => Effect.Effect<void>,
): SandboxService => {
  const id = (script.id ?? "mock-sandbox") as SandboxId

  const acquireInstance = (sandboxId: SandboxId, onClose: Effect.Effect<void>) =>
    Effect.gen(function* () {
      const fs = yield* Ref.make(seedFs(script.files))
      const execCursor = yield* Ref.make(0)
      const streamCursor = yield* Ref.make(0)
      const spawnCursor = yield* Ref.make(0)
      yield* Effect.addFinalizer(() => onClose)
      return buildInstance(sandboxId, script, fs, execCursor, streamCursor, spawnCursor, record)
    })

  return {
    create: (request) =>
      record(Call.Create({ request })).pipe(
        Effect.andThen(acquireInstance(id, record(Call.Destroy({ id })))),
      ),

    attach: (sandboxId) =>
      record(Call.Attach({ id: sandboxId })).pipe(
        // Attach detaches on scope close (no destroy).
        Effect.andThen(acquireInstance(sandboxId, Effect.void)),
      ),

    list: Effect.succeed(script.sandboxes ?? []),

    destroy: (sandboxId) => record(Call.Destroy({ id: sandboxId })),

    snapshots: {
      create: (_from, name) =>
        record(
          name === undefined ? Call.SnapshotCreate({ id }) : Call.SnapshotCreate({ id, name }),
        ).pipe(
          Effect.as(
            `mock-snapshot-${name ?? Math.random().toString(36).slice(2, 8)}` as SnapshotId,
          ),
        ),
      destroy: (sid) => record(Call.SnapshotDestroy({ id: sid })),
      list: Effect.succeed(script.snapshots ?? []),
    },

    volumes: {
      create: (name, options) =>
        record(
          options?.quotaBytes === undefined
            ? Call.VolumeCreate({ name })
            : Call.VolumeCreate({ name, quotaBytes: options.quotaBytes }),
        ).pipe(Effect.as(`mock-volume-${name}` as VolumeId)),
      destroy: (vid) => record(Call.VolumeDestroy({ id: vid })),
      list: Effect.succeed(script.volumes ?? []),
    },

    ports: {
      expose: (instance, port) =>
        record(Call.ExposePort({ id: instance.id, port })).pipe(
          Effect.as({ url: (script.portUrl ?? ((p) => `http://mock.local:${p}`))(port) }),
        ),
    },
  }
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

const makeRecorderUnsafe = () => {
  const ref = Ref.makeUnsafe<ReadonlyArray<Call>>([])
  return {
    record: (call: Call) => Ref.update(ref, Arr.append(call)),
    recorder: Ref.get(ref).pipe(Effect.map((calls): MockSandboxRecorder => ({ calls }))),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const allCapabilities = Layer.mergeAll(
  Layer.succeed(SandboxHostnameAllowlist, undefined),
  Layer.succeed(SandboxSecretInjection, undefined),
  Layer.succeed(SandboxSnapshots, undefined),
  Layer.succeed(SandboxPauseResume, undefined),
  Layer.succeed(SandboxVolumes, undefined),
  Layer.succeed(SandboxKernelSession, undefined),
  Layer.succeed(SandboxPty, undefined),
  Layer.succeed(SandboxCustomImage, undefined),
  Layer.succeed(SandboxPortExposure, undefined),
)

/**
 * Layer that registers a `MockSandbox` against the `Sandbox` tag, with
 * every capability marker shipped — use when the code under test
 * exercises any of them.
 */
export const layer = (script: MockSandboxScript = {}) => {
  const { record, recorder } = makeRecorderUnsafe()
  return {
    layer: Layer.merge(Layer.succeed(Sandbox, buildService(script, record)), allCapabilities),
    recorder,
  }
}

/**
 * Layer with the `Sandbox` service but no capability markers. Use to
 * verify that consumers calling `Sandbox.snapshot` / `createVolume` /
 * etc. fail at `Effect.provide` with a type error.
 */
export const layerWithoutCapabilities = (script: MockSandboxScript = {}) => {
  const { record, recorder } = makeRecorderUnsafe()
  return {
    layer: Layer.succeed(Sandbox, buildService(script, record)),
    recorder,
  }
}

/** Bare service value + recorder. Use with `Effect.provideService`. */
export const make = (script: MockSandboxScript = {}) => {
  const { record, recorder } = makeRecorderUnsafe()
  return {
    service: buildService(script, record),
    recorder,
  }
}
