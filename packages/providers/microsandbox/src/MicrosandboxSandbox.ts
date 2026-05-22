import {
  ExecEvent as CoreExecEvent,
  Sandbox as CoreSandbox,
  SandboxHostnameAllowlist,
  SandboxPauseResume,
  SandboxSecretInjection,
  SandboxSnapshots,
  SandboxVolumes,
  type CommonCreateRequest,
  type CommonExecRequest,
  type ExecResult,
  type ImageRef,
  type NetworkPolicy,
  type ProcessHandle,
  type SandboxId,
  type SandboxInstance,
  type SandboxRef,
  type SandboxService,
  type SnapshotId,
  type VolumeId,
} from "@effect-uai/core/Sandbox"
import * as SandboxError from "@effect-uai/core/SandboxError"
import {
  Array as Arr,
  Effect,
  Filter,
  Layer,
  Match,
  Option,
  Record,
  Redacted,
  Stream,
} from "effect"
import {
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
// Provider-narrowed request — extends the common shape with the
// Microsandbox-specific knobs the SDK exposes. `name` is what
// microsandbox keys by; we mint a random one when absent.
// ---------------------------------------------------------------------------

export type MicrosandboxCreateRequest = CommonCreateRequest & {
  readonly name?: string
  readonly cpus?: number
  readonly memoryMib?: number
  readonly workdir?: string
  readonly user?: string
  readonly maxDurationSecs?: number
  readonly idleTimeoutSecs?: number
  /**
   * Stop any existing sandbox with the same name before creating.
   * `true` = `SIGTERM` with the SDK default grace; `{ graceMs }` =
   * explicit grace before `SIGKILL`.
   */
  readonly replace?: boolean | { readonly graceMs: number }
  /**
   * Detach so the sandbox outlives the calling scope. The scope
   * finalizer skips `stop()`; clean up via {@link Sandbox.destroy}.
   */
  readonly detached?: boolean
}

export type MicrosandboxConfig = {
  /** Default OCI image to use when no `image` is supplied on create. */
  readonly defaultImage?: string
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const reasonOf = (e: unknown) => (e instanceof Error ? { reason: e.message } : {})

const mapCreateError = (e: unknown): SandboxError.SandboxError =>
  e instanceof SandboxStillRunningError
    ? new SandboxError.SandboxAlreadyExists({ provider: PROVIDER, id: e.message })
    : e instanceof SandboxNotFoundError
      ? new SandboxError.SandboxNotFound({ provider: PROVIDER, id: e.message })
      : new SandboxError.SandboxCreateFailed({ provider: PROVIDER, raw: e, ...reasonOf(e) })

const mapExecError = (e: unknown): SandboxError.SandboxError =>
  e instanceof ExecTimeoutError
    ? new SandboxError.SandboxTimeout({ provider: PROVIDER, operation: "exec", raw: e })
    : new SandboxError.SandboxExecFailed({ provider: PROVIDER, raw: e, ...reasonOf(e) })

const mapFsError = (e: unknown): SandboxError.SandboxError =>
  new SandboxError.SandboxExecFailed({ provider: PROVIDER, raw: e, ...reasonOf(e) })

const mapLookupError =
  (id: string) =>
  (e: unknown): SandboxError.SandboxError =>
    e instanceof SandboxNotFoundError
      ? new SandboxError.SandboxNotFound({ provider: PROVIDER, id })
      : mapCreateError(e)

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

const execConfigure =
  (args: ReadonlyArray<string>, request: CommonExecRequest): ExecConfigure =>
  (b) => {
    const withArgs = args.length === 0 ? b : b.args([...args])
    const withCwd = request.cwd === undefined ? withArgs : withArgs.cwd(request.cwd)
    const withEnv =
      request.env === undefined
        ? withCwd
        : Record.reduce(request.env, withCwd, (acc, v, k) => acc.env(k, v))
    return request.timeoutMs === undefined ? withEnv : withEnv.timeout(request.timeoutMs)
  }

// ---------------------------------------------------------------------------
// MsbExecEvent → Option<CoreExecEvent>. `started` carries the pid but
// downstream observers don't need it — drop via `Option.none()`.
// Microsandbox uses `kind` as the discriminator, so `Match.discriminators`.
// ---------------------------------------------------------------------------

const execEventFromMsb = (startedAt: number) =>
  Match.type<MsbExecEvent>().pipe(
    Match.discriminators("kind")({
      started: (): Option.Option<CoreExecEvent> => Option.none(),
      stdout: ({ data }) => Option.some(CoreExecEvent.Stdout({ chunk: data })),
      stderr: ({ data }) => Option.some(CoreExecEvent.Stderr({ chunk: data })),
      exited: ({ code }) =>
        Option.some(CoreExecEvent.Complete({ exitCode: code, durationMs: Date.now() - startedAt })),
    }),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Live SandboxInstance adapter.
// ---------------------------------------------------------------------------

const adaptInstance = (msb: MsbSandbox): SandboxInstance => {
  const id = msb.name as SandboxId

  const openExecStream = (request: CommonExecRequest) =>
    Effect.gen(function* () {
      const { cmd, args } = yield* argv(request.cmd)
      const handle = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => msb.execStreamWith(cmd, execConfigure(args, request)),
          catch: mapExecError,
        }),
        (h) => Effect.promise(() => h[Symbol.asyncDispose]()),
      )
      return { handle, startedAt: Date.now() }
    })

  return {
    id,

    exec: (request) =>
      Effect.gen(function* () {
        const { cmd, args } = yield* argv(request.cmd)
        const startedAt = Date.now()
        const output = yield* Effect.tryPromise({
          try: () => msb.execWith(cmd, execConfigure(args, request)),
          catch: mapExecError,
        })
        const result: ExecResult = {
          exitCode: output.code,
          stdout: output.stdout(),
          stderr: output.stderr(),
          durationMs: Date.now() - startedAt,
        }
        return result
      }),

    execStream: (request) =>
      Stream.unwrap(
        Effect.map(openExecStream(request), ({ handle, startedAt }) =>
          Stream.fromAsyncIterable(handle, mapExecError).pipe(
            Stream.filterMap(Filter.fromPredicateOption(execEventFromMsb(startedAt))),
          ),
        ),
      ),

    spawn: (request) =>
      Effect.map(
        openExecStream(request),
        ({ handle, startedAt }): ProcessHandle => ({
          // Microsandbox surfaces pid via the "started" event; the
          // handle exposes no sync getter. Surface 0 until it does.
          pid: 0,
          events: Stream.fromAsyncIterable(handle, mapExecError).pipe(
            Stream.filterMap(Filter.fromPredicateOption(execEventFromMsb(startedAt))),
          ),
          kill: Effect.tryPromise({ try: () => handle.kill(), catch: mapExecError }),
          exit: Effect.tryPromise({ try: () => handle.wait(), catch: mapExecError }).pipe(
            Effect.map((status) => ({ exitCode: status.code })),
          ),
        }),
      ),

    files: {
      read: (path) => Effect.tryPromise({ try: () => msb.fs().read(path), catch: mapFsError }),
      write: (path, contents) =>
        Effect.tryPromise({ try: () => msb.fs().write(path, contents), catch: mapFsError }),
      remove: (path) => Effect.tryPromise({ try: () => msb.fs().remove(path), catch: mapFsError }),
      mkdir: (path) => Effect.tryPromise({ try: () => msb.fs().mkdir(path), catch: mapFsError }),
      list: (path) =>
        Effect.tryPromise({ try: () => msb.fs().list(path), catch: mapFsError }).pipe(
          Effect.map(Arr.map((e) => ({ path: e.path, kind: e.kind }))),
        ),
      exists: (path) => Effect.tryPromise({ try: () => msb.fs().exists(path), catch: mapFsError }),
    },

    exposePort: () =>
      Effect.fail(
        new SandboxError.SandboxUnsupported({
          provider: PROVIDER,
          capability: "exposePort",
          reason:
            "microsandbox exposes guest ports via host-side port forwarding configured at create time; runtime exposure is not supported",
        }),
      ),
  }
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

const buildService = (config: MicrosandboxConfig): SandboxService => {
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
        when(request.maxDurationSecs, (s) => (b) => b.maxDuration(s)),
        when(request.idleTimeoutSecs, (s) => (b) => b.idleTimeout(s)),
        when(request.timeoutMs, (ms) => (b) => b.maxDuration(Math.ceil(ms / 1000))),
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

  return {
    create: (request) =>
      Effect.gen(function* () {
        const req = request as MicrosandboxCreateRequest
        const name = req.name ?? `eff-uai-${Math.random().toString(36).slice(2, 10)}`
        const msb = yield* Effect.acquireRelease(acquireSandbox(req, name), (s) =>
          // Finalizers must not throw; swallow `stop()` failures.
          Effect.promise(() => (s.ownsLifecycle ? s.stop().catch(() => {}) : Promise.resolve())),
        )
        return adaptInstance(msb)
      }),

    attach: (id) =>
      Effect.map(
        Effect.acquireRelease(
          Effect.tryPromise({ try: () => MsbSandbox.start(id), catch: mapLookupError(id) }),
          // Detach on scope close — do NOT stop.
          () => Effect.void,
        ),
        adaptInstance,
      ),

    list: Effect.tryPromise({ try: () => MsbSandbox.list(), catch: mapCreateError }).pipe(
      Effect.map(Arr.map((h): SandboxRef => ({ id: h.name as SandboxId, name: h.name }))),
    ),

    destroy: (id) =>
      Effect.tryPromise({ try: () => MsbSandbox.remove(id), catch: mapLookupError(id) }),

    snapshots: {
      create: (from, name) =>
        Effect.tryPromise({
          try: async () => {
            const builder = MsbSnapshot.builder(from.id as string)
            const named = name === undefined ? builder : builder.name(name)
            const snap = await named.create()
            return snap.inner.digest as SnapshotId
          },
          catch: mapCreateError,
        }),
      destroy: (sid) =>
        Effect.tryPromise({
          try: () => MsbSnapshot.get(sid).then((h) => h.remove?.()),
          catch: mapLookupError(sid),
        }).pipe(Effect.asVoid),
      list: Effect.tryPromise({ try: () => MsbSnapshot.list(), catch: mapCreateError }).pipe(
        Effect.map(
          Arr.map((h) =>
            h.name === null
              ? { id: h.digest as SnapshotId }
              : { id: h.digest as SnapshotId, name: h.name },
          ),
        ),
      ),
    },

    volumes: {
      create: (name, options) =>
        Effect.tryPromise({
          try: async () => {
            const builder = MsbVolume.builder(name)
            const sized =
              options?.quotaBytes === undefined
                ? builder
                : builder.quota(Math.ceil(options.quotaBytes / (1024 * 1024)))
            const vol = await sized.create()
            return vol.name as VolumeId
          },
          catch: mapCreateError,
        }),
      destroy: (vid) =>
        Effect.tryPromise({ try: () => MsbVolume.remove(vid), catch: mapLookupError(vid) }),
      list: Effect.tryPromise({ try: () => MsbVolume.list(), catch: mapCreateError }).pipe(
        Effect.map(Arr.map((h) => ({ id: h.name as VolumeId, name: h.name }))),
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
 * - {@link SandboxPauseResume} — `Sandbox.start(name)` resumes a
 *   stopped sandbox by name; the same id survives across the pause.
 *
 * NOT shipped (calling those helpers fails at compile time):
 * - `SandboxCustomImage` — accepts OCI registry refs only.
 * - `SandboxPortExposure` — ports forwarded at create time; runtime
 *   `exposePort` calls fail with `SandboxUnsupported`.
 * - `SandboxKernelSession`, `SandboxPty` — no Jupyter/REPL/PTY.
 */
export const layer = (config: MicrosandboxConfig = {}) =>
  Layer.mergeAll(
    Layer.succeed(CoreSandbox, buildService(config)),
    Layer.succeed(SandboxHostnameAllowlist, undefined),
    Layer.succeed(SandboxSecretInjection, undefined),
    Layer.succeed(SandboxSnapshots, undefined),
    Layer.succeed(SandboxVolumes, undefined),
    Layer.succeed(SandboxPauseResume, undefined),
  )
