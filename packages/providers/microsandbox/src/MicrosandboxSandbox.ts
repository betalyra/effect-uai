import {
  ExecEvent as CoreExecEvent,
  Sandbox as CoreSandbox,
  SandboxHostnameAllowlist,
  SandboxSecretInjection,
  SandboxSnapshots,
  SandboxVolumes,
  type BoundSecret,
  type CommonCreateRequest,
  type CommonExecRequest,
  type ExecResult,
  type ImageRef,
  type NetworkPolicy,
  type CommonSpawnRequest,
  type ProcessHandle,
  SandboxId,
  type SandboxInstance,
  type SandboxRef,
  type SandboxService,
  SnapshotId,
  VolumeId,
} from "@effect-uai/core/Sandbox"
import * as SandboxError from "@effect-uai/core/SandboxError"
import {
  Array as Arr,
  Clock,
  Context,
  Duration,
  Effect,
  Filter,
  Layer,
  Match,
  Option,
  Random,
  Record,
  Redacted,
  Result,
  Schedule,
  Scope,
  Stream,
} from "effect"
import {
  type ExecHandle as MsbExecHandle,
  ExecTimeoutError,
  NetworkPolicyBuilder,
  Sandbox as MsbSandbox,
  SandboxNotFoundError,
  SandboxStillRunningError,
  Snapshot as MsbSnapshot,
  Volume as MsbVolume,
  type ExecEvent as MsbExecEvent,
  type SandboxBuilder as MsbSandboxBuilder,
} from "microsandbox"

const PROVIDER = "microsandbox"

// ---------------------------------------------------------------------------
// Provider-narrowed request types.
//
// Microsandbox's secret-injection wire only supports the default
// `Authorization: Bearer <value>` header convention — there's no
// per-secret custom header. We omit `header` on the typed surface
// (row B / type-level narrowing); calls via the generic `Sandbox.create`
// surface that set `header` are rejected at runtime (row D
// `SandboxUnsupported`) — see the upcast adapter in `layer`.
// ---------------------------------------------------------------------------

export type MicrosandboxBoundSecret = Omit<BoundSecret, "header">

export type MicrosandboxCreateRequest = Omit<CommonCreateRequest, "secrets"> & {
  readonly secrets?: ReadonlyArray<MicrosandboxBoundSecret>
  readonly name?: string
  readonly cpus?: number
  readonly memoryMib?: number
  readonly workdir?: string
  readonly user?: string
  readonly maxDuration?: Duration.Input
  readonly idleTimeout?: Duration.Input
  /**
   * Stop any existing sandbox with the same name before creating.
   * `true` = `SIGTERM` with the SDK default grace; `{ graceMs }` =
   * explicit grace before `SIGKILL`.
   */
  readonly replace?: boolean | { readonly graceMs: number }
  /**
   * Detach so the sandbox outlives the calling scope. The scope
   * finalizer skips destroy; clean up via {@link Sandbox.destroy}.
   */
  readonly detached?: boolean
}

export type MicrosandboxConfig = {
  /** Default OCI image to use when no `image` is supplied on create. */
  readonly defaultImage?: string
}

/**
 * Microsandbox-narrowed service. `create` accepts the narrowed
 * {@link MicrosandboxCreateRequest}; every other method is identical
 * to the generic {@link SandboxService}.
 */
export type MicrosandboxSandboxService = Omit<SandboxService, "create"> & {
  readonly create: (
    request: MicrosandboxCreateRequest,
  ) => Effect.Effect<SandboxInstance, SandboxError.SandboxError, Scope.Scope>
}

export class MicrosandboxSandbox extends Context.Service<
  MicrosandboxSandbox,
  MicrosandboxSandboxService
>()("@betalyra/effect-uai/providers/microsandbox/MicrosandboxSandbox") {}

// ---------------------------------------------------------------------------
// Effect-native primitives
// ---------------------------------------------------------------------------

/** Random base-36 token, ~8 chars. Stand-in for `Math.random` IDs. */
const randomToken = Random.next.pipe(Effect.map((r) => r.toString(36).slice(2, 10)))

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const reasonOf = (e: unknown) => (e instanceof Error ? { reason: e.message } : {})

const mapCreateError = (e: unknown): SandboxError.SandboxError =>
  e instanceof SandboxStillRunningError
    ? new SandboxError.SandboxAlreadyExists({
        provider: PROVIDER,
        id: e.message,
      })
    : e instanceof SandboxNotFoundError
      ? new SandboxError.SandboxNotFound({ provider: PROVIDER, id: e.message })
      : new SandboxError.SandboxCreateFailed({
          provider: PROVIDER,
          raw: e,
          ...reasonOf(e),
        })

const mapExecError = (e: unknown): SandboxError.SandboxError =>
  e instanceof ExecTimeoutError
    ? new SandboxError.SandboxTimeout({
        provider: PROVIDER,
        operation: "exec",
        raw: e,
      })
    : new SandboxError.SandboxExecFailed({
        provider: PROVIDER,
        raw: e,
        ...reasonOf(e),
      })

const mapFsError = (e: unknown): SandboxError.SandboxError =>
  new SandboxError.SandboxExecFailed({
    provider: PROVIDER,
    raw: e,
    ...reasonOf(e),
  })

const mapLookupError =
  (id: string) =>
  (e: unknown): SandboxError.SandboxError =>
    e instanceof SandboxNotFoundError
      ? new SandboxError.SandboxNotFound({ provider: PROVIDER, id })
      : mapCreateError(e)

// ---------------------------------------------------------------------------
// Stopping & post-kill DB sync.
//
// Empirically (spike + SDK 0.4.6):
// - `handle.connect()` + `live.stopAndWait()` resolves in 0ms on a
//   non-owning connection — the VM keeps running. Useless.
// - `handle.kill()` signals the runtime to terminate, but the DB row's
//   `status` field only flips to "stopped" ~200ms later. Operations
//   that re-read DB status (`MsbSandbox.remove`, `handle.snapshot`)
//   reject during that window with a "still running" error.
//
// Rather than a fixed sleep (which over- and under-shoots), we kill
// then retry the next operation on the transient race with exponential
// backoff. Typical recovery: 1–3 retries (~50–350ms). Budget is 5
// attempts ≈ 50+100+200+400+800 = 1.55s — plenty of margin for a
// loaded host.
// ---------------------------------------------------------------------------

const settleSchedule = Schedule.exponential("50 millis")
const SETTLE_RETRIES = 5

/**
 * Microsandbox's post-kill DB sync window surfaces as "still running"
 * either via `SandboxStillRunningError` (mapped to `SandboxAlreadyExists`
 * by {@link mapCreateError}) or, for `handle.snapshot`, a generic
 * `MicrosandboxError` whose message contains "is not stopped" /
 * "still running" (mapped to `SandboxCreateFailed`).
 */
const isPostKillRace = (e: SandboxError.SandboxError) =>
  e._tag === "SandboxAlreadyExists" ||
  (e._tag === "SandboxCreateFailed" &&
    typeof e.reason === "string" &&
    /still running|is not stopped/i.test(e.reason))

const retryOnSettle = <A, R>(
  effect: Effect.Effect<A, SandboxError.SandboxError, R>,
): Effect.Effect<A, SandboxError.SandboxError, R> =>
  Effect.retry(effect, {
    schedule: settleSchedule,
    times: SETTLE_RETRIES,
    while: isPostKillRace,
  })

/** Force-kill a running sandbox. No-op if absent or already stopped. */
const killRunning = (id: string) =>
  Effect.tryPromise({
    try: () => MsbSandbox.get(id),
    catch: mapLookupError(id),
  }).pipe(
    Effect.flatMap((handle) =>
      handle.status === "running"
        ? Effect.tryPromise({
            try: () => handle.kill(),
            catch: mapLookupError(id),
          })
        : Effect.void,
    ),
    Effect.catchTag("SandboxNotFound", () => Effect.void),
  )

/** Stop + remove. Idempotent — `SandboxNotFound` is treated as success. */
const destroyById = (id: SandboxId) =>
  killRunning(id).pipe(
    Effect.andThen(
      retryOnSettle(
        Effect.tryPromise({
          try: () => MsbSandbox.remove(id),
          catch: mapLookupError(id),
        }),
      ),
    ),
    Effect.catchTag("SandboxNotFound", () => Effect.void),
  )

// ---------------------------------------------------------------------------
// Builder pipeline — a `Step` is a pure builder→builder transformation.
// The create flow folds an array of Steps through the initial builder.
// ---------------------------------------------------------------------------

type Step = (b: MsbSandboxBuilder) => MsbSandboxBuilder

const noop: Step = (b) => b

const when = <A>(value: A | undefined, step: (a: A) => Step): Step =>
  value === undefined ? noop : step(value)

// ---------------------------------------------------------------------------
// ImageRef → Step. Snapshots / registry honored; Default falls through
// to the layer's `defaultImage`; Dockerfile is unsupported.
// ---------------------------------------------------------------------------

const imageStep =
  (defaultImage: string | undefined) =>
  (image: ImageRef | undefined): Effect.Effect<Step, SandboxError.SandboxError> => {
    const fromDefault: Effect.Effect<Step, SandboxError.SandboxError> =
      defaultImage === undefined
        ? Effect.fail(
            new SandboxError.SandboxUnsupported({
              provider: PROVIDER,
              capability: "image",
              reason:
                "microsandbox requires an image — pass `image` on the request or set `defaultImage` on the layer config",
            }),
          )
        : Effect.succeed((b) => b.image(defaultImage))

    if (image === undefined) return fromDefault

    return Match.value(image).pipe(
      Match.tag("Default", () => fromDefault),
      Match.tag(
        "Registry",
        ({ ref }): Effect.Effect<Step, SandboxError.SandboxError> =>
          Effect.succeed((b) => b.image(ref)),
      ),
      Match.tag(
        "Snapshot",
        ({ id }): Effect.Effect<Step, SandboxError.SandboxError> =>
          Effect.succeed((b) => b.fromSnapshot(id)),
      ),
      Match.tag(
        "Dockerfile",
        (): Effect.Effect<Step, SandboxError.SandboxError> =>
          Effect.fail(
            new SandboxError.SandboxUnsupported({
              provider: PROVIDER,
              capability: "image",
              reason: "microsandbox accepts OCI registry refs or snapshots, not Dockerfiles",
            }),
          ),
      ),
      Match.exhaustive,
    )
  }

// ---------------------------------------------------------------------------
// NetworkPolicy → Step. CIDRs and hostnames both honored.
// ---------------------------------------------------------------------------

const buildPolicy = (hosts: ReadonlyArray<string>, cidrs: ReadonlyArray<string>) => {
  const withHosts = Arr.reduce(hosts, new NetworkPolicyBuilder().defaultDeny(), (pb, host) =>
    pb.rule((rb) => rb.egress().allowDomain(host)),
  )
  return Arr.reduce(cidrs, withHosts, (pb, cidr) =>
    pb.rule((rb) => rb.egress().allow((d) => d.cidr(cidr))),
  )
}

const networkStep = (policy: NetworkPolicy): Step =>
  Match.value(policy).pipe(
    Match.tag("Open", (): Step => noop),
    Match.tag("Blocked", (): Step => (b) => b.disableNetwork()),
    Match.tag(
      "Allowlist",
      ({ hosts, cidrs }): Step =>
        (b) =>
          b.network((n) => n.policyFromBuilder(buildPolicy(hosts ?? [], cidrs ?? []))),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Secret / volume / replace Steps. Each item folds into its own Step;
// the create pipeline reduces them through the builder.
// ---------------------------------------------------------------------------

const secretStep =
  (secret: {
    readonly name: string
    readonly value: Redacted.Redacted<string>
    readonly hosts: ReadonlyArray<string>
  }): Step =>
  (b) =>
    b.secret((sb) =>
      Arr.reduce(
        secret.hosts,
        sb.env(secret.name).value(Redacted.value(secret.value)),
        (acc, host) => acc.allowHost(host),
      ).injectHeaders(true),
    )

const volumeStep =
  (vol: { readonly id: VolumeId; readonly mountPath: string; readonly readonly?: boolean }): Step =>
  (b) =>
    b.volume(vol.mountPath, (m) => (vol.readonly ? m.named(vol.id).readonly() : m.named(vol.id)))

const replaceStep = (replace: MicrosandboxCreateRequest["replace"]): Step =>
  replace === true
    ? (b) => b.replace()
    : typeof replace === "object"
      ? (b) => b.replaceWithGrace(replace.graceMs)
      : noop

// ---------------------------------------------------------------------------
// argv splitter — string is run via shell semantics by the SDK, array
// is direct argv. Empty argv is a typed error.
// ---------------------------------------------------------------------------

const argv = (
  cmd: CommonExecRequest["cmd"],
): Effect.Effect<
  { readonly cmd: string; readonly args: ReadonlyArray<string> },
  SandboxError.SandboxError
> =>
  typeof cmd === "string"
    ? Effect.succeed({ cmd, args: [] as ReadonlyArray<string> })
    : Option.match(Arr.head(cmd), {
        onNone: () =>
          Effect.fail(
            new SandboxError.SandboxInvalidRequest({
              provider: PROVIDER,
              param: "cmd",
              reason: "argv array must be non-empty",
            }),
          ),
        onSome: (head) => Effect.succeed({ cmd: head, args: Arr.drop(cmd, 1) }),
      })

// ---------------------------------------------------------------------------
// CommonExecRequest → ExecOptionsBuilder configurator.
// ---------------------------------------------------------------------------

type ExecConfigure = Parameters<MsbSandbox["execWith"]>[1]

const toBuffer = (input: Uint8Array | string) =>
  typeof input === "string" ? Buffer.from(input, "utf-8") : Buffer.from(input)

/**
 * `string` / `Uint8Array` stdin uses one-shot `stdinBytes`; a Stream
 * uses `stdinPipe` and gets fed via `feedStdin` once the handle is open.
 */
const stdinIsStream = (
  stdin: CommonSpawnRequest["stdin"],
): stdin is Stream.Stream<Uint8Array, never, never> =>
  stdin !== undefined && typeof stdin !== "string" && !(stdin instanceof Uint8Array)

const execConfigure =
  (args: ReadonlyArray<string>, request: CommonSpawnRequest): ExecConfigure =>
  (b) => {
    const withArgs = args.length === 0 ? b : b.args([...args])
    const withCwd = request.cwd === undefined ? withArgs : withArgs.cwd(request.cwd)
    const withEnv =
      request.env === undefined
        ? withCwd
        : Record.reduce(request.env, withCwd, (acc, v, k) => acc.env(k, v))
    const withTimeout =
      request.timeout === undefined
        ? withEnv
        : withEnv.timeout(Duration.toMillis(Duration.fromInputUnsafe(request.timeout)))
    if (request.stdin === undefined) return withTimeout
    if (stdinIsStream(request.stdin)) return withTimeout.stdinPipe()
    return withTimeout.stdinBytes(toBuffer(request.stdin))
  }

// ---------------------------------------------------------------------------
// Stream stdin → SDK `ExecSink`. Takes the writer once, pumps each
// chunk via `sink.write(Buffer)`, closes on stream completion. Errors
// from the SDK side (sink already taken / closed / process exited
// mid-stream) are mapped through {@link mapExecError}. Caller forks
// this against a `Scope` so the pump dies with the spawn.
// ---------------------------------------------------------------------------

const feedStreamStdin = (
  handle: MsbExecHandle,
  stream: Stream.Stream<Uint8Array, never, never>,
): Effect.Effect<void, SandboxError.SandboxError> =>
  Effect.tryPromise({
    try: () => handle.takeStdin(),
    catch: mapExecError,
  }).pipe(
    Effect.flatMap((sink) =>
      sink === null
        ? Effect.fail(
            new SandboxError.SandboxInvalidRequest({
              provider: PROVIDER,
              param: "stdin",
              reason: "stdin sink already taken — the SDK exposes it once per spawn",
            }),
          )
        : Stream.runForEach(stream, (chunk) =>
            Effect.tryPromise({
              try: () => sink.write(Buffer.from(chunk)),
              catch: mapExecError,
            }),
          ).pipe(
            Effect.andThen(
              Effect.tryPromise({
                try: () => sink.close(),
                catch: mapExecError,
              }),
            ),
          ),
    ),
  )

// ---------------------------------------------------------------------------
// MsbExecEvent → Option<CoreExecEvent>. `started` carries the pid but
// downstream observers don't need it — drop via `Option.none()`.
// Duration is precomputed by the caller (Clock-based).
// ---------------------------------------------------------------------------

const execEventFromMsb = (event: MsbExecEvent, durationMs: number): Option.Option<CoreExecEvent> =>
  Match.value(event).pipe(
    Match.discriminators("kind")({
      started: () => Option.none<CoreExecEvent>(),
      stdout: ({ data }) => Option.some(CoreExecEvent.Stdout({ chunk: data })),
      stderr: ({ data }) => Option.some(CoreExecEvent.Stderr({ chunk: data })),
      exited: ({ code }) => Option.some(CoreExecEvent.Complete({ exitCode: code, durationMs })),
    }),
    Match.exhaustive,
  )

const someEvent = Filter.fromPredicateOption((o: Option.Option<CoreExecEvent>) => o)

const eventStream = (handle: AsyncIterable<MsbExecEvent>, startedAt: number) =>
  Stream.fromAsyncIterable(handle, mapExecError).pipe(
    Stream.mapEffect((event) =>
      Effect.map(Clock.currentTimeMillis, (now) => execEventFromMsb(event, now - startedAt)),
    ),
    Stream.filterMap(someEvent),
  )

// ---------------------------------------------------------------------------
// Live SandboxInstance adapter.
// ---------------------------------------------------------------------------

const adaptInstance = (msb: MsbSandbox): SandboxInstance => {
  const id = SandboxId(msb.name)

  const openExecStream = (request: CommonSpawnRequest) =>
    Effect.gen(function* () {
      const { cmd, args } = yield* argv(request.cmd)
      const startedAt = yield* Clock.currentTimeMillis
      // `asyncDispose` alone drops the relay connection but does NOT
      // terminate the guest process — sleep / dev servers / watchers
      // happily keep running. Explicitly kill first; both calls are
      // safe to invoke on an already-exited handle.
      const handle = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => msb.execStreamWith(cmd, execConfigure(args, request)),
          catch: mapExecError,
        }),
        (h) =>
          Effect.tryPromise({
            try: () => h.kill(),
            catch: () => undefined,
          }).pipe(Effect.ignore, Effect.andThen(Effect.promise(() => h[Symbol.asyncDispose]()))),
      )
      // Stream stdin: fork a fiber that drains the user's stream into
      // the SDK's `ExecSink`, closing on completion. Scoped to the
      // caller's scope so it dies if the spawn is interrupted.
      if (stdinIsStream(request.stdin)) {
        yield* Effect.forkScoped(feedStreamStdin(handle, request.stdin))
      }
      return { handle, startedAt }
    })

  return {
    id,

    exec: (request) =>
      Effect.gen(function* () {
        const { cmd, args } = yield* argv(request.cmd)
        const startedAt = yield* Clock.currentTimeMillis
        const output = yield* Effect.tryPromise({
          try: () => msb.execWith(cmd, execConfigure(args, request)),
          catch: mapExecError,
        })
        const completedAt = yield* Clock.currentTimeMillis
        return {
          exitCode: output.code,
          stdout: output.stdout(),
          stderr: output.stderr(),
          durationMs: completedAt - startedAt,
        } satisfies ExecResult
      }),

    execStream: (request) =>
      Stream.unwrap(
        Effect.map(openExecStream(request), ({ handle, startedAt }) =>
          eventStream(handle, startedAt),
        ),
      ),

    spawn: (request) =>
      Effect.map(
        openExecStream(request),
        ({ handle, startedAt }): ProcessHandle => ({
          // Microsandbox surfaces pid via the "started" event; the
          // handle exposes no sync getter. Surface 0 until it does.
          pid: 0,
          events: eventStream(handle, startedAt),
          kill: Effect.tryPromise({
            try: () => handle.kill(),
            catch: mapExecError,
          }),
          exit: Effect.tryPromise({
            try: () => handle.wait(),
            catch: mapExecError,
          }).pipe(Effect.map((status) => ({ exitCode: status.code }))),
        }),
      ),

    files: {
      read: (path) =>
        Effect.tryPromise({
          try: () => msb.fs().read(path),
          catch: mapFsError,
        }),
      write: (path, contents) =>
        Effect.tryPromise({
          try: () => msb.fs().write(path, contents),
          catch: mapFsError,
        }),
      remove: (path) =>
        Effect.tryPromise({
          try: () => msb.fs().remove(path),
          catch: mapFsError,
        }),
      mkdir: (path) =>
        Effect.tryPromise({
          try: () => msb.fs().mkdir(path),
          catch: mapFsError,
        }),
      list: (path) =>
        Effect.tryPromise({
          try: () => msb.fs().list(path),
          catch: mapFsError,
        }).pipe(Effect.map(Arr.map((e) => ({ path: e.path, kind: e.kind })))),
      exists: (path) =>
        Effect.tryPromise({
          try: () => msb.fs().exists(path),
          catch: mapFsError,
        }),
    },
  }
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

const buildService = (config: MicrosandboxConfig): MicrosandboxSandboxService => {
  const resolveImageStep = imageStep(config.defaultImage)

  const acquireSandbox = (request: MicrosandboxCreateRequest, name: string) =>
    Effect.gen(function* () {
      const img = yield* resolveImageStep(request.image)

      const steps: ReadonlyArray<Step> = [
        img,
        when(request.cpus, (n) => (b) => b.cpus(n)),
        when(request.memoryMib, (n) => (b) => b.memory(n)),
        when(request.workdir, (p) => (b) => b.workdir(p)),
        when(request.user, (u) => (b) => b.user(u)),
        when(
          request.maxDuration,
          (d) => (b) =>
            b.maxDuration(Math.ceil(Duration.toMillis(Duration.fromInputUnsafe(d)) / 1000)),
        ),
        when(
          request.idleTimeout,
          (d) => (b) =>
            b.idleTimeout(Math.ceil(Duration.toMillis(Duration.fromInputUnsafe(d)) / 1000)),
        ),
        when(
          request.timeout,
          (t) => (b) =>
            b.maxDuration(Math.ceil(Duration.toMillis(Duration.fromInputUnsafe(t)) / 1000)),
        ),
        when(request.env, (env) => (b) => b.envs(env)),
        when(request.network, networkStep),
        ...Arr.map(request.secrets ?? [], secretStep),
        ...Arr.map(request.volumes ?? [], volumeStep),
        replaceStep(request.replace),
      ]

      const built = Arr.reduce(steps, MsbSandbox.builder(name), (b, step) => step(b))
      return yield* Effect.tryPromise({
        try: () => (request.detached ? built.createDetached() : built.create()),
        catch: mapCreateError,
      })
    })

  // Attach picks the right resume path: `connect()` for an already-
  // running (e.g. detached) sandbox, `startDetached()` for a stopped
  // one. Plain `MsbSandbox.start(id)` rejects on running sandboxes,
  // which breaks the detached-survives-scope-close flow.
  const acquireAttached = (id: SandboxId) =>
    Effect.tryPromise({
      try: () => MsbSandbox.get(id),
      catch: mapLookupError(id),
    }).pipe(
      Effect.flatMap((handle) =>
        Effect.tryPromise({
          try: handle.status === "running" ? () => handle.connect() : () => handle.startDetached(),
          catch: mapLookupError(id),
        }),
      ),
    )

  return {
    create: (request) =>
      Effect.gen(function* () {
        const token = yield* randomToken
        const name = SandboxId(request.name ?? `eff-uai-${token}`)
        const detached = request.detached === true
        // Detached sandboxes outlive the scope — finalizer skips
        // teardown and the user calls `destroy(id)` explicitly.
        const msb = yield* Effect.acquireRelease(acquireSandbox(request, name), () =>
          detached ? Effect.void : Effect.ignore(destroyById(name)),
        )
        return adaptInstance(msb)
      }),

    attach: (id) =>
      Effect.acquireRelease(
        acquireAttached(id),
        // Detach on scope close — do NOT stop.
        () => Effect.void,
      ).pipe(Effect.map(adaptInstance)),

    list: Effect.tryPromise({
      try: () => MsbSandbox.list(),
      catch: mapCreateError,
    }).pipe(Effect.map(Arr.map((h): SandboxRef => ({ id: SandboxId(h.name), name: h.name })))),

    destroy: destroyById,

    snapshots: {
      // Microsandbox requires the source sandbox to be stopped before
      // snapshotting. We must also flush root-FS writes BEFORE stop:
      // SDK 0.4.6's stop path races the guest poweroff and `fs().write`
      // data sitting in page cache never reaches the upper.ext4. Fix
      // landed upstream as microsandbox#746 but isn't released — we
      // call `sync` via exec first. Drop this `flush` step once the
      // SDK is bumped past the fix.
      //
      // `SandboxHandle.snapshot(name)` registers the artifact in the
      // DB index (visible to `Snapshot.list` / `msb snapshot list` /
      // `fromSnapshot(name)`); `Snapshot.builder` skips that, so we
      // go through the handle. The handle's `inner.status` is read at
      // fetch time, so we re-`get` AFTER the stop has settled.
      create: (from, name) =>
        Effect.gen(function* () {
          const token = yield* randomToken
          const snapName = name ?? `eff-uai-snap-${token}`
          yield* Effect.ignore(from.exec({ cmd: ["sync"] }))
          yield* killRunning(from.id)
          // Re-`get` per attempt: `SandboxHandle.status` is snapshotted
          // at fetch time, so a stale handle would keep failing even
          // after the DB lands the "stopped" status.
          yield* retryOnSettle(
            Effect.tryPromise({
              try: () => MsbSandbox.get(from.id),
              catch: mapLookupError(from.id),
            }).pipe(
              Effect.flatMap((handle) =>
                Effect.tryPromise({
                  try: () => handle.snapshot(snapName),
                  catch: mapCreateError,
                }),
              ),
            ),
          )
          return SnapshotId(snapName)
        }),
      destroy: (sid) =>
        Effect.tryPromise({
          try: () => MsbSnapshot.get(sid),
          catch: mapLookupError(sid),
        }).pipe(
          Effect.flatMap((h) =>
            Effect.tryPromise({
              try: () => h.remove(),
              catch: mapLookupError(sid),
            }),
          ),
        ),
      list: Effect.tryPromise({
        try: () => MsbSnapshot.list(),
        catch: mapCreateError,
      }).pipe(
        Effect.map(
          Arr.filterMap((h) =>
            h.name === null
              ? Result.failVoid
              : Result.succeed({ id: SnapshotId(h.name), name: h.name }),
          ),
        ),
      ),
    },

    volumes: {
      create: (name, options) => {
        const builder = MsbVolume.builder(name)
        const sized =
          options?.quotaBytes === undefined
            ? builder
            : builder.quota(Math.ceil(options.quotaBytes / (1024 * 1024)))
        return Effect.tryPromise({
          try: () => sized.create(),
          catch: mapCreateError,
        }).pipe(Effect.map((vol) => VolumeId(vol.name)))
      },
      destroy: (vid) =>
        Effect.tryPromise({
          try: () => MsbVolume.remove(vid),
          catch: mapLookupError(vid),
        }),
      list: Effect.tryPromise({
        try: () => MsbVolume.list(),
        catch: mapCreateError,
      }).pipe(Effect.map(Arr.map((h) => ({ id: VolumeId(h.name), name: h.name })))),
    },

    ports: {
      // Defensive stub. The Layer doesn't ship `SandboxPortExposure`,
      // so the free helper `Sandbox.exposePort` is a compile error
      // against this provider. This stub only fires if a caller
      // bypassed the marker and reached into `s.ports.expose` directly.
      expose: () =>
        Effect.fail(
          new SandboxError.SandboxUnsupported({
            provider: PROVIDER,
            capability: "ports.expose",
            reason:
              "microsandbox forwards guest ports to host ports at create time via the per-provider request; runtime port exposure is not supported",
          }),
        ),
    },
  }
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * Layer that registers the Microsandbox adapter against the `Sandbox`
 * tag, with the capability markers Microsandbox actually supports.
 *
 * Shipped:
 * - {@link SandboxHostnameAllowlist} — `allowDomain` rules at the
 *   policy layer (TLS-edge inspection / DNS filtering).
 * - {@link SandboxSecretInjection} — `.secret(...)` placeholder
 *   substitution; the real value never enters the guest.
 * - {@link SandboxSnapshots} — `Snapshot.builder(sourceSandbox)`.
 * - {@link SandboxVolumes} — `Volume.builder(name)`.
 *
 * NOT shipped (calling those helpers fails at compile time):
 * - `SandboxPauseResume` — microsandbox's `stop()` + `Sandbox.start(name)`
 *   resumes a previously stopped sandbox from disk, but RAM/process
 *   state is lost. That's different semantics from E2B-style
 *   memory-preserving pause/resume which `SandboxPauseResume` is
 *   meant to denote.
 * - `SandboxCustomImage` — accepts OCI registry refs only.
 * - `SandboxPortExposure` — ports are forwarded at create time via the
 *   per-provider request; runtime `exposePort` is unavailable.
 * - `SandboxKernelSession`, `SandboxPty` — no Jupyter/REPL/PTY.
 */
// Row-D guard: reject `BoundSecret.header` when callers route through
// the generic `Sandbox.create` surface (the typed `MicrosandboxSandbox`
// surface omits the field at the type level — row B). Microsandbox's
// secret API doesn't accept arbitrary headers; silently dropping would
// produce wrong outbound auth, so we fail loudly.
const rejectCustomHeader = (
  secrets: CommonCreateRequest["secrets"],
): Effect.Effect<void, SandboxError.SandboxError> =>
  secrets === undefined || !secrets.some((s) => s.header !== undefined)
    ? Effect.void
    : Effect.fail(
        new SandboxError.SandboxUnsupported({
          provider: PROVIDER,
          capability: "BoundSecret.header",
          reason:
            "microsandbox always injects secrets as `Authorization: Bearer <value>` — custom headers aren't supported. Use the narrowed `MicrosandboxSandbox.create` surface, which omits this field.",
        }),
      )

const upcastService = (s: MicrosandboxSandboxService): SandboxService => ({
  ...s,
  create: (request) =>
    rejectCustomHeader(request.secrets).pipe(
      Effect.andThen(s.create(request as MicrosandboxCreateRequest)),
    ),
})

export const layer = (config: MicrosandboxConfig = {}) => {
  const service = buildService(config)
  return Layer.mergeAll(
    Layer.succeed(MicrosandboxSandbox, service),
    Layer.succeed(CoreSandbox, upcastService(service)),
    Layer.succeed(SandboxHostnameAllowlist, undefined),
    Layer.succeed(SandboxSecretInjection, undefined),
    Layer.succeed(SandboxSnapshots, undefined),
    Layer.succeed(SandboxVolumes, undefined),
  )
}
