import * as Memory from "@effect-uai/core/Memory"
import {
  ExecEvent as CoreExecEvent,
  Sandbox as CoreSandbox,
  SandboxHostnameAllowlist,
  SandboxPortExposure,
  SandboxSecretInjection,
  SandboxSnapshots,
  SandboxVolumes,
  type BoundSecret,
  type CommonCreateRequest,
  type CommonExecRequest,
  type CommonSpawnRequest,
  type ExecResult,
  type ImageRef,
  type NetworkPolicy,
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
  Layer,
  Match,
  Option,
  Random,
  Redacted,
  Schedule,
  Scope,
  Stream,
} from "effect"
import {
  ApiError,
  Client,
  ConnectionClosedError,
  ConnectionEstablishmentError,
  InvalidMemoryError,
  InvalidTimeoutError,
  InvalidTokenError,
  MissingTokenError,
  Sandbox as DenoSdkSandbox,
  SandboxCommandError,
  SandboxKillError,
  type ChildProcess as DenoChildProcess,
  type SandboxOptions,
  type SecretConfig,
} from "@deno/sandbox"

const PROVIDER = "deno"

// ---------------------------------------------------------------------------
// Provider-narrowed request types.
//
// Deno's `secrets: Record<name, SecretConfig>` shape has no per-secret
// custom header — substitution is always "Authorization: Bearer <value>".
// We omit `header` on the typed surface (row B) and reject at the upcast
// adapter (row D) if a caller routes through the generic `Sandbox.create`.
// ---------------------------------------------------------------------------

export type DenoSandboxBoundSecret = Omit<BoundSecret, "header">

export type DenoRegion = "ord" | "ams"

export type DenoSandboxCreateRequest = Omit<CommonCreateRequest, "secrets"> & {
  readonly secrets?: ReadonlyArray<DenoSandboxBoundSecret>
  readonly region?: DenoRegion
  /**
   * Memory size for the sandbox. Accepts a byte count, a {@link Memory.Memory},
   * or a human string like `"1280 MiB"` / `"1 GiB"`. Deno's accepted
   * range at GA is 768 MiB – 4 GiB (default 1280 MiB).
   */
  readonly memory?: Memory.Input
  readonly labels?: Readonly<Record<string, string>>
  /** Auto-expose this port at boot; the live sandbox's `url` reaches it. */
  readonly port?: number
}

export type DenoSandboxConfig = {
  /** Overrides `DENO_DEPLOY_TOKEN`. */
  readonly token?: Redacted.Redacted<string>
  /** Overrides `DENO_DEPLOY_ORG`. Required for personal `ddp_` tokens. */
  readonly org?: string
  /** Overrides `DENO_DEPLOY_ENDPOINT`. */
  readonly apiEndpoint?: string
  /** Default region when create requests omit one. */
  readonly defaultRegion?: DenoRegion
}

/**
 * Deno-narrowed service. `create` accepts the narrowed
 * {@link DenoSandboxCreateRequest}; every other method is identical to
 * the generic {@link SandboxService} except for the per-provider
 * `snapshotVolume` escape hatch — Deno snapshots are derived from
 * volumes, not from live sandboxes, so the generic
 * `Sandbox.snapshots.create(fromInstance)` doesn't fit and fails with
 * `SandboxUnsupported`.
 */
export type DenoSandboxService = Omit<SandboxService, "create"> & {
  readonly create: (
    request: DenoSandboxCreateRequest,
  ) => Effect.Effect<SandboxInstance, SandboxError.SandboxError, Scope.Scope>
  /**
   * Snapshot an existing volume by id/slug. Deno's snapshot model is
   * volume-derived, so the generic `Sandbox.snapshots.create` doesn't
   * apply — use this escape hatch instead. The volume must not be
   * attached to any running sandbox at the time of snapshot.
   */
  readonly snapshotVolume: (
    volumeId: VolumeId,
    slug?: string,
  ) => Effect.Effect<SnapshotId, SandboxError.SandboxError>
}

export class DenoSandbox extends Context.Service<DenoSandbox, DenoSandboxService>()(
  "@betalyra/effect-uai/providers/deno/DenoSandbox",
) {}

// ---------------------------------------------------------------------------
// Effect-native primitives
// ---------------------------------------------------------------------------

/** Random base-36 token, ~8 chars. */
const randomToken = Random.next.pipe(Effect.map((r) => r.toString(36).slice(2, 10)))

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

const reasonOf = (e: unknown) => (e instanceof Error ? { reason: e.message } : {})

const isAuthError = (e: unknown): boolean =>
  e instanceof MissingTokenError ||
  e instanceof InvalidTokenError ||
  (e instanceof ApiError && (e.status === 401 || e.status === 403)) ||
  (e instanceof ConnectionEstablishmentError && (e.status === 401 || e.status === 403))

const isQuotaError = (e: unknown): boolean =>
  (e instanceof ApiError && e.status === 429) ||
  (e instanceof ConnectionEstablishmentError && e.status === 429)

/**
 * "Sandbox is no longer reachable" — covers both the 404 (never existed)
 * and the 400 + `SANDBOX_ALREADY_TERMINATED` case the API returns when
 * you `connect` to a sandbox after its `kill`. Both map to
 * `SandboxNotFound` so `destroy` and friends stay idempotent.
 */
const isNotFoundError = (e: unknown): boolean =>
  (e instanceof ApiError && (e.status === 404 || e.code === "SANDBOX_ALREADY_TERMINATED")) ||
  (e instanceof ConnectionEstablishmentError &&
    (e.status === 404 || e.code === "SANDBOX_ALREADY_TERMINATED"))

const mapCreateError = (e: unknown): SandboxError.SandboxError =>
  isAuthError(e)
    ? new SandboxError.SandboxAuthFailed({ provider: PROVIDER, subtype: "auth", raw: e })
    : isQuotaError(e)
      ? new SandboxError.SandboxQuotaExceeded({
          provider: PROVIDER,
          raw: e,
          ...reasonOf(e),
        })
      : e instanceof InvalidTimeoutError || e instanceof InvalidMemoryError
        ? new SandboxError.SandboxInvalidRequest({
            provider: PROVIDER,
            raw: e,
            ...reasonOf(e),
          })
        : new SandboxError.SandboxCreateFailed({
            provider: PROVIDER,
            raw: e,
            ...reasonOf(e),
          })

const mapLookupError =
  (id: string) =>
  (e: unknown): SandboxError.SandboxError =>
    isNotFoundError(e)
      ? new SandboxError.SandboxNotFound({ provider: PROVIDER, id })
      : mapCreateError(e)

const mapExecError = (e: unknown): SandboxError.SandboxError =>
  e instanceof SandboxCommandError
    ? new SandboxError.SandboxExecFailed({
        provider: PROVIDER,
        raw: e,
        reason: e.message,
      })
    : e instanceof ConnectionClosedError
      ? new SandboxError.SandboxExecFailed({
          provider: PROVIDER,
          raw: e,
          reason: e.reason ?? "connection closed",
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

// ---------------------------------------------------------------------------
// Transient WebSocket handshake failures.
//
// Empirically (SDK 0.13.2): `sdk.spawn` opens a per-process WebSocket
// to the sandbox-side relay. The Deploy edge intermittently returns
// `500 SANDBOX_WEBSOCKET_HANDSHAKE_ERROR` on this handshake; the next
// attempt against the same sandbox typically succeeds. Retry narrowly
// on that specific code rather than blanketing all 5xx — most are not
// transient.
//
// Budget: 3 attempts ≈ 500+1000+2000 = 3.5s on top of the original
// call, well under the 120s test timeout.
// ---------------------------------------------------------------------------

const isTransientWsHandshake = (e: SandboxError.SandboxError) =>
  (e._tag === "SandboxExecFailed" || e._tag === "SandboxCreateFailed") &&
  e.raw instanceof ConnectionEstablishmentError &&
  e.raw.code === "SANDBOX_WEBSOCKET_HANDSHAKE_ERROR"

const wsHandshakeSchedule = Schedule.exponential("500 millis")
const WS_HANDSHAKE_RETRIES = 3

const retryOnTransientWs = <A, R>(
  effect: Effect.Effect<A, SandboxError.SandboxError, R>,
): Effect.Effect<A, SandboxError.SandboxError, R> =>
  Effect.retry(effect, {
    schedule: wsHandshakeSchedule,
    times: WS_HANDSHAKE_RETRIES,
    while: isTransientWsHandshake,
  })

// ---------------------------------------------------------------------------
// Builder pipeline — a `Step` mutates `SandboxOptions`. Deno's create
// API is a plain options object (no builder fluent API), so each Step
// returns a partial overlay; the create flow folds them into the base.
// Keeping the same shape as microsandbox's `Step` pattern means optional
// fields read uniformly.
// ---------------------------------------------------------------------------

type OptionsPatch = Partial<SandboxOptions>
type Step = (patch: OptionsPatch) => OptionsPatch

const noop: Step = (p) => p

const when = <A>(value: A | undefined, step: (a: A) => Step): Step =>
  value === undefined ? noop : step(value)

const set =
  <K extends keyof SandboxOptions>(key: K, value: SandboxOptions[K]): Step =>
  (p) => ({ ...p, [key]: value })

// ---------------------------------------------------------------------------
// Duration → Deno timeout format ("30s"). Deno's `create.timeout`
// accepts `"session" | "${number}s" | "${number}m"`; we always emit
// `<seconds>s` since seconds is the most precise unit honored.
// ---------------------------------------------------------------------------

const toDenoSeconds = (d: Duration.Input): `${number}s` => {
  const secs = Math.max(1, Math.ceil(Duration.toMillis(Duration.fromInputUnsafe(d)) / 1000))
  return `${secs}s`
}

// ---------------------------------------------------------------------------
// ImageRef → Step. Default omits `root`; Snapshot sets it; Registry /
// Dockerfile are unsupported and fail at decode.
// ---------------------------------------------------------------------------

const imageStep = (image: ImageRef | undefined): Effect.Effect<Step, SandboxError.SandboxError> => {
  if (image === undefined) return Effect.succeed(noop)
  return Match.value(image).pipe(
    Match.tag(
      "Default",
      (): Effect.Effect<Step, SandboxError.SandboxError> => Effect.succeed(noop),
    ),
    Match.tag(
      "Snapshot",
      ({ id }): Effect.Effect<Step, SandboxError.SandboxError> => Effect.succeed(set("root", id)),
    ),
    Match.tag(
      "Registry",
      (): Effect.Effect<Step, SandboxError.SandboxError> =>
        Effect.fail(
          new SandboxError.SandboxUnsupported({
            provider: PROVIDER,
            capability: "image.registry",
            reason: "deno sandboxes do not accept OCI registry refs — boot from a snapshot instead",
          }),
        ),
    ),
    Match.tag(
      "Dockerfile",
      (): Effect.Effect<Step, SandboxError.SandboxError> =>
        Effect.fail(
          new SandboxError.SandboxUnsupported({
            provider: PROVIDER,
            capability: "image.dockerfile",
            reason:
              "deno sandboxes do not accept Dockerfiles — install software into a bootable volume then snapshot it",
          }),
        ),
    ),
    Match.exhaustive,
  )
}

// ---------------------------------------------------------------------------
// NetworkPolicy → Step. Deno accepts hostnames + literal IPs but no
// CIDR ranges; reject `cidrs` rather than silently dropping. `Blocked`
// encodes as empty allowlist; `Open` omits the field.
// ---------------------------------------------------------------------------

const networkStep = (policy: NetworkPolicy): Effect.Effect<Step, SandboxError.SandboxError> =>
  Match.value(policy).pipe(
    Match.tag("Open", (): Effect.Effect<Step, SandboxError.SandboxError> => Effect.succeed(noop)),
    Match.tag(
      "Blocked",
      (): Effect.Effect<Step, SandboxError.SandboxError> => Effect.succeed(set("allowNet", [])),
    ),
    Match.tag(
      "Allowlist",
      ({ hosts, cidrs }): Effect.Effect<Step, SandboxError.SandboxError> =>
        cidrs !== undefined && cidrs.length > 0
          ? Effect.fail(
              new SandboxError.SandboxUnsupported({
                provider: PROVIDER,
                capability: "network.cidrs",
                reason:
                  "deno's allowNet accepts hostnames or literal IPs, not CIDR ranges — use hosts instead",
              }),
            )
          : Effect.succeed(set("allowNet", [...(hosts ?? [])])),
    ),
    Match.exhaustive,
  )

// ---------------------------------------------------------------------------
// Volumes → Step. Deno mounts read-write only; reject `readonly: true`.
// ---------------------------------------------------------------------------

const volumesStep = (
  volumes: CommonCreateRequest["volumes"],
): Effect.Effect<Step, SandboxError.SandboxError> => {
  if (volumes === undefined || volumes.length === 0) return Effect.succeed(noop)
  if (volumes.some((v) => v.readonly === true)) {
    return Effect.fail(
      new SandboxError.SandboxUnsupported({
        provider: PROVIDER,
        capability: "volumes.readonly",
        reason: "deno mounts volumes read-write — read-only mounts are not supported",
      }),
    )
  }
  const map = Arr.reduce(volumes, {} as Record<string, string>, (acc, v) => {
    acc[v.mountPath] = v.id
    return acc
  })
  return Effect.succeed(set("volumes", map))
}

// ---------------------------------------------------------------------------
// Secrets → Step. Stays sync — no decode-time failure modes (custom
// header is rejected upstream in the upcast).
// ---------------------------------------------------------------------------

const secretsStep = (secrets: ReadonlyArray<DenoSandboxBoundSecret>): Step => {
  const record = Arr.reduce(secrets, {} as Record<string, SecretConfig>, (acc, s) => {
    acc[s.name] = { hosts: [...s.hosts], value: Redacted.value(s.value) }
    return acc
  })
  return set("secrets", record)
}

// ---------------------------------------------------------------------------
// Base client options used for both client construction and per-call
// overrides. `token` is a Redacted — we unwrap at the SDK boundary.
// ---------------------------------------------------------------------------

const baseClientOptions = (config: DenoSandboxConfig): SandboxOptions => ({
  ...(config.token === undefined ? {} : { token: Redacted.value(config.token) }),
  ...(config.org === undefined ? {} : { org: config.org }),
  ...(config.apiEndpoint === undefined ? {} : { apiEndpoint: config.apiEndpoint }),
})

// ---------------------------------------------------------------------------
// argv splitter. Deno's `spawn(command, { args })` is direct argv only —
// for `cmd: string` (shell semantics) we route through `bash -c`.
// ---------------------------------------------------------------------------

const argv = (
  cmd: CommonExecRequest["cmd"],
): Effect.Effect<
  { readonly command: string; readonly args: ReadonlyArray<string> },
  SandboxError.SandboxError
> =>
  typeof cmd === "string"
    ? Effect.succeed({ command: "bash", args: ["-c", cmd] })
    : Option.match(Arr.head(cmd), {
        onNone: () =>
          Effect.fail(
            new SandboxError.SandboxInvalidRequest({
              provider: PROVIDER,
              param: "cmd",
              reason: "argv array must be non-empty",
            }),
          ),
        onSome: (head) => Effect.succeed({ command: head, args: Arr.drop(cmd, 1) }),
      })

// ---------------------------------------------------------------------------
// AbortController scoped to the caller. On scope close we abort, which
// signals the SDK to terminate the in-flight call. This is the kill-
// switch the SDK responds to.
// ---------------------------------------------------------------------------

const acquireAbortController: Effect.Effect<AbortController, never, Scope.Scope> =
  Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (ac) => Effect.sync(() => ac.abort()),
  )

// ---------------------------------------------------------------------------
// stdin helpers
// ---------------------------------------------------------------------------

const stdinIsStream = (
  stdin: CommonSpawnRequest["stdin"],
): stdin is Stream.Stream<Uint8Array, never, never> =>
  stdin !== undefined && typeof stdin !== "string" && !(stdin instanceof Uint8Array)

/**
 * Copy into a fresh `Uint8Array<ArrayBuffer>`. The Deno SDK strictly
 * types its bytes argument as `Uint8Array<ArrayBuffer>` (not the
 * `ArrayBufferLike` upper bound), so `TextEncoder`-produced bytes and
 * caller-supplied Uint8Arrays need to be copied to a guaranteed-
 * `ArrayBuffer`-backed buffer to satisfy the type.
 */
const toBytes = (input: Uint8Array | string): Uint8Array<ArrayBuffer> => {
  const src = typeof input === "string" ? new TextEncoder().encode(input) : input
  const out = new Uint8Array(new ArrayBuffer(src.byteLength))
  out.set(src)
  return out
}

/**
 * Acquire the child's stdin writer, run `use(writer)`, then close the
 * writer on release (regardless of success / failure / interrupt).
 * Returns `Effect.void` if the child wasn't spawned with `stdin: "piped"`.
 */
const withStdinWriter = <A, E, R>(
  child: DenoChildProcess,
  use: (writer: WritableStreamDefaultWriter<Uint8Array>) => Effect.Effect<A, E, R>,
): Effect.Effect<void | A, E | SandboxError.SandboxError, R> => {
  const stdin = child.stdin
  if (stdin === null) return Effect.void
  return Effect.acquireUseRelease(
    Effect.sync(() => stdin.getWriter()),
    use,
    (writer) => Effect.promise(() => writer.close().catch(() => undefined)).pipe(Effect.ignore),
  )
}

const writeStdinBytes = (
  child: DenoChildProcess,
  bytes: Uint8Array,
): Effect.Effect<void, SandboxError.SandboxError> =>
  withStdinWriter(child, (writer) =>
    Effect.tryPromise({ try: () => writer.write(bytes), catch: mapExecError }),
  ).pipe(Effect.asVoid)

const feedStreamStdin = (
  child: DenoChildProcess,
  source: Stream.Stream<Uint8Array, never, never>,
): Effect.Effect<void, SandboxError.SandboxError> =>
  withStdinWriter(child, (writer) =>
    Stream.runForEach(source, (chunk) =>
      Effect.tryPromise({ try: () => writer.write(chunk), catch: mapExecError }),
    ),
  ).pipe(Effect.asVoid)

// ---------------------------------------------------------------------------
// ReadableStream<Uint8Array> → Stream<Uint8Array>.
// ---------------------------------------------------------------------------

const streamFromReadable = (
  readable: ReadableStream<Uint8Array>,
): Stream.Stream<Uint8Array, SandboxError.SandboxError> =>
  Stream.fromReadableStream({
    evaluate: () => readable,
    onError: mapExecError,
  })

// ---------------------------------------------------------------------------
// Merge stdout + stderr into a tagged ExecEvent stream terminated by a
// single Complete event derived from `child.status`.
// ---------------------------------------------------------------------------

const eventStream = (
  child: DenoChildProcess,
  startedAt: number,
): Stream.Stream<CoreExecEvent, SandboxError.SandboxError> => {
  const stdout: Stream.Stream<CoreExecEvent, SandboxError.SandboxError> =
    child.stdout === null
      ? Stream.empty
      : Stream.map(streamFromReadable(child.stdout), (chunk) => CoreExecEvent.Stdout({ chunk }))
  const stderr: Stream.Stream<CoreExecEvent, SandboxError.SandboxError> =
    child.stderr === null
      ? Stream.empty
      : Stream.map(streamFromReadable(child.stderr), (chunk) => CoreExecEvent.Stderr({ chunk }))
  const complete: Stream.Stream<CoreExecEvent, SandboxError.SandboxError> = Stream.unwrap(
    Effect.gen(function* () {
      const status = yield* Effect.tryPromise({ try: () => child.status, catch: mapExecError })
      const now = yield* Clock.currentTimeMillis
      return Stream.succeed(
        CoreExecEvent.Complete({ exitCode: status.code, durationMs: now - startedAt }),
      )
    }),
  )
  return Stream.concat(Stream.merge(stdout, stderr), complete)
}

// ---------------------------------------------------------------------------
// Per-exec timeout. Races against `Effect.sleep` so the parent scope
// finalizers (which kill the child via `acquireRelease`) fire on breach.
// We don't lean on `Effect.timeout` because it returns `Option`-shaped
// fallbacks in v4; the race-based shape lets us keep the SandboxError
// channel directly.
// ---------------------------------------------------------------------------

const withExecTimeout = <A, R>(
  timeout: Duration.Input | undefined,
  effect: Effect.Effect<A, SandboxError.SandboxError, R>,
): Effect.Effect<A, SandboxError.SandboxError, R> =>
  timeout === undefined
    ? effect
    : Effect.race(
        effect,
        Effect.sleep(timeout).pipe(
          Effect.andThen(
            Effect.fail(
              new SandboxError.SandboxTimeout({
                provider: PROVIDER,
                operation: "exec",
                budget: Duration.fromInputUnsafe(timeout),
              }),
            ),
          ),
        ),
      )

// ---------------------------------------------------------------------------
// Live SandboxInstance adapter. The `WeakMap<SandboxInstance, sdk>`
// passed in is the back-reference used by the port-exposure sub-API
// to recover the SDK handle from an opaque `SandboxInstance`.
// ---------------------------------------------------------------------------

const adaptInstance = (
  sdk: DenoSdkSandbox,
  portRegistry: WeakMap<SandboxInstance, DenoSdkSandbox>,
): SandboxInstance => {
  const id = SandboxId(sdk.id)

  const openProcess = (request: CommonSpawnRequest) =>
    Effect.gen(function* () {
      const { command, args } = yield* argv(request.cmd)
      const ac = yield* acquireAbortController
      const stdinMode: "piped" | "null" = request.stdin === undefined ? "null" : "piped"
      const startedAt = yield* Clock.currentTimeMillis
      const child = yield* Effect.acquireRelease(
        retryOnTransientWs(
          Effect.tryPromise({
            try: () =>
              sdk.spawn(command, {
                args: [...args],
                ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
                ...(request.env === undefined ? {} : { env: { ...request.env } }),
                stdin: stdinMode,
                stdout: "piped",
                stderr: "piped",
                signal: ac.signal,
              }),
            catch: mapExecError,
          }),
        ),
        (c) => Effect.promise(() => c.kill("SIGKILL").catch(() => undefined)).pipe(Effect.ignore),
      )
      if (request.stdin !== undefined) {
        if (stdinIsStream(request.stdin)) {
          yield* Effect.forkScoped(feedStreamStdin(child, request.stdin))
        } else {
          yield* writeStdinBytes(child, toBytes(request.stdin))
        }
      }
      return { child, startedAt }
    })

  const instance: SandboxInstance = {
    id,

    exec: (request) =>
      withExecTimeout(
        request.timeout,
        Effect.scoped(
          Effect.gen(function* () {
            const { child, startedAt } = yield* openProcess(request)
            const output = yield* Effect.tryPromise({
              try: () => child.output(),
              catch: mapExecError,
            })
            const completedAt = yield* Clock.currentTimeMillis
            return {
              exitCode: output.status.code,
              stdout: output.stdoutText ?? "",
              stderr: output.stderrText ?? "",
              durationMs: completedAt - startedAt,
            } satisfies ExecResult
          }),
        ),
      ),

    execStream: (request) =>
      Stream.unwrap(
        Effect.map(openProcess(request), ({ child, startedAt }) => eventStream(child, startedAt)),
      ),

    spawn: (request) =>
      Effect.map(
        openProcess(request),
        ({ child, startedAt }): ProcessHandle => ({
          pid: child.pid,
          events: eventStream(child, startedAt),
          kill: Effect.tryPromise({
            try: () => child.kill("SIGTERM"),
            catch: mapExecError,
          }),
          exit: Effect.tryPromise({
            try: () => child.status,
            catch: mapExecError,
          }).pipe(Effect.map((status) => ({ exitCode: status.code }))),
        }),
      ),

    files: {
      read: (path) => Effect.tryPromise({ try: () => sdk.fs.readFile(path), catch: mapFsError }),
      write: (path, contents) =>
        Effect.tryPromise({
          try: () => sdk.fs.writeFile(path, toBytes(contents)),
          catch: mapFsError,
        }),
      remove: (path) => Effect.tryPromise({ try: () => sdk.fs.remove(path), catch: mapFsError }),
      mkdir: (path) =>
        Effect.tryPromise({
          try: () => sdk.fs.mkdir(path, { recursive: true }),
          catch: mapFsError,
        }),
      list: (path) =>
        Stream.fromAsyncIterable(sdk.fs.readDir(path), mapFsError).pipe(
          Stream.map((e) => ({
            path: e.name,
            kind: e.isFile
              ? ("file" as const)
              : e.isDirectory
                ? ("directory" as const)
                : e.isSymlink
                  ? ("symlink" as const)
                  : ("other" as const),
          })),
          Stream.runCollect,
        ),
      exists: (path) =>
        Effect.tryPromise({
          try: () => sdk.fs.stat(path),
          catch: mapFsError,
        }).pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        ),
    },
  }

  portRegistry.set(instance, sdk)
  return instance
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------

const buildService = (config: DenoSandboxConfig): DenoSandboxService => {
  const clientOpts = baseClientOptions(config)
  const client = new Client(clientOpts)
  const portRegistry = new WeakMap<SandboxInstance, DenoSdkSandbox>()

  const buildOptions = (
    request: DenoSandboxCreateRequest,
  ): Effect.Effect<SandboxOptions, SandboxError.SandboxError> =>
    Effect.gen(function* () {
      const img = yield* imageStep(request.image)
      const net = yield* request.network === undefined
        ? Effect.succeed(noop)
        : networkStep(request.network)
      const vols = yield* volumesStep(request.volumes)

      const steps: ReadonlyArray<Step> = [
        img,
        when(request.region ?? config.defaultRegion, (r) => set("region", r)),
        when(request.env, (env) => set("env", { ...env })),
        when(request.timeout, (t) => set("timeout", toDenoSeconds(t))),
        when(request.memory, (m) => set("memory", Memory.toBytes(m))),
        when(request.labels, (l) => set("labels", { ...l })),
        net,
        vols,
        when(request.secrets, (s) => (s.length === 0 ? noop : secretsStep(s))),
        when(request.port, (p) => set("port", p)),
      ]
      const overlay = Arr.reduce(steps, {} as OptionsPatch, (acc, step) => step(acc))
      return { ...clientOpts, ...overlay }
    })

  const acquireSdk = (request: DenoSandboxCreateRequest) =>
    Effect.flatMap(buildOptions(request), (opts) =>
      Effect.tryPromise({ try: () => DenoSdkSandbox.create(opts), catch: mapCreateError }),
    )

  const releaseSdk = (sdk: DenoSdkSandbox) =>
    Effect.promise(() => sdk.kill().catch(() => undefined)).pipe(Effect.ignore)

  const releaseAttached = (sdk: DenoSdkSandbox) =>
    Effect.promise(() => sdk.close().catch(() => undefined)).pipe(Effect.ignore)

  const destroyById = (id: SandboxId) =>
    Effect.tryPromise({
      try: () => DenoSdkSandbox.connect(id, clientOpts),
      catch: mapLookupError(id),
    }).pipe(
      Effect.flatMap((sdk) =>
        Effect.tryPromise({ try: () => sdk.kill(), catch: mapLookupError(id) }),
      ),
      Effect.catchTag("SandboxNotFound", () => Effect.void),
    )

  return {
    create: (request) =>
      Effect.acquireRelease(acquireSdk(request), releaseSdk).pipe(
        Effect.map((sdk) => adaptInstance(sdk, portRegistry)),
      ),

    attach: (id) =>
      Effect.acquireRelease(
        Effect.tryPromise({
          try: () => DenoSdkSandbox.connect(id, clientOpts),
          catch: mapLookupError(id),
        }),
        releaseAttached,
      ).pipe(Effect.map((sdk) => adaptInstance(sdk, portRegistry))),

    list: Effect.tryPromise({
      try: () => client.sandboxes.list(),
      catch: mapCreateError,
    }).pipe(Effect.map(Arr.map((m): SandboxRef => ({ id: SandboxId(m.id) })))),

    destroy: destroyById,

    snapshotVolume: (volumeId, slug) =>
      Effect.gen(function* () {
        const snapSlug = slug ?? `eff-uai-snap-${yield* randomToken}`
        const snap = yield* Effect.tryPromise({
          try: () => client.volumes.snapshot(volumeId, { slug: snapSlug }),
          catch: mapCreateError,
        })
        return SnapshotId(snap.slug)
      }),

    snapshots: {
      create: () =>
        Effect.fail(
          new SandboxError.SandboxUnsupported({
            provider: PROVIDER,
            capability: "snapshots.create",
            reason:
              "deno snapshots are derived from volumes, not from running sandboxes — use DenoSandbox.snapshotVolume(volumeId, slug?) instead",
          }),
        ),
      destroy: (sid) =>
        Effect.tryPromise({
          try: () => client.snapshots.delete(sid),
          catch: mapLookupError(sid),
        }),
      list: Stream.unwrap(
        Effect.tryPromise({
          try: () => client.snapshots.list(),
          catch: mapCreateError,
        }).pipe(Effect.map((page) => Stream.fromAsyncIterable(page, mapCreateError))),
      ).pipe(
        Stream.map((snap) => ({ id: SnapshotId(snap.id), name: snap.slug })),
        Stream.runCollect,
      ),
    },

    volumes: {
      create: (name, options) =>
        Effect.tryPromise({
          try: () =>
            client.volumes.create({
              slug: name,
              // Volumes are only available in `ord` at the moment.
              // Callers needing a different region can pre-create via
              // the SDK directly.
              region: config.defaultRegion ?? "ord",
              capacity: options?.quotaBytes ?? "1GB",
            }),
          catch: mapCreateError,
        }).pipe(Effect.map((vol) => VolumeId(vol.slug))),
      destroy: (vid) =>
        Effect.tryPromise({
          try: () => client.volumes.delete(vid),
          catch: mapLookupError(vid),
        }),
      list: Stream.unwrap(
        Effect.tryPromise({
          try: () => client.volumes.list(),
          catch: mapCreateError,
        }).pipe(Effect.map((page) => Stream.fromAsyncIterable(page, mapCreateError))),
      ).pipe(
        Stream.map((vol) => ({ id: VolumeId(vol.slug), name: vol.slug })),
        Stream.runCollect,
      ),
    },

    ports: {
      expose: (instance, port) =>
        Effect.gen(function* () {
          const sdk = portRegistry.get(instance)
          if (sdk === undefined) {
            return yield* Effect.fail(
              new SandboxError.SandboxNotFound({ provider: PROVIDER, id: instance.id }),
            )
          }
          const url = yield* Effect.tryPromise({
            try: () => sdk.exposeHttp({ port }),
            catch: mapExecError,
          })
          return { url }
        }),
    },
  }
}

// ---------------------------------------------------------------------------
// Cross-provider upcast — reject custom header on BoundSecret since
// Deno doesn't support per-secret headers.
// ---------------------------------------------------------------------------

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
            "deno always injects secrets as `Authorization: Bearer <value>` — custom headers aren't supported. Use the narrowed `DenoSandbox.create` surface, which omits this field.",
        }),
      )

const upcastService = (s: DenoSandboxService): SandboxService => ({
  ...s,
  create: (request) =>
    rejectCustomHeader(request.secrets).pipe(
      Effect.andThen(s.create(request as DenoSandboxCreateRequest)),
    ),
})

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

/**
 * Layer registering the Deno Sandbox adapter against `Sandbox`, with
 * the capability markers Deno actually supports.
 *
 * Shipped:
 * - {@link SandboxHostnameAllowlist} — `allowNet` accepts hostnames + wildcards.
 * - {@link SandboxSecretInjection} — `secrets.<name>.value` is injected
 *   only on outbound HTTPS to bound hosts; in-VM env shows a placeholder.
 * - {@link SandboxSnapshots} — read-side helpers (`list`, `destroy`)
 *   work. `snapshots.create(fromInstance)` fails with
 *   `SandboxUnsupported`; use the per-provider
 *   `DenoSandbox.snapshotVolume` escape hatch for the volume-derived
 *   snapshot workflow.
 * - {@link SandboxVolumes} — `client.volumes.*` directly.
 * - {@link SandboxPortExposure} — `sandbox.exposeHttp({ port })`.
 *
 * NOT shipped (calling those helpers fails at compile time):
 * - `SandboxCustomImage` — no Dockerfile / no OCI registry refs.
 * - `SandboxPauseResume` — Deno doesn't offer in-place memory-preserving pause.
 * - `SandboxKernelSession`, `SandboxPty` — no Jupyter / no PTY.
 */
export const layer = (config: DenoSandboxConfig = {}) => {
  const service = buildService(config)
  return Layer.mergeAll(
    Layer.succeed(DenoSandbox, service),
    Layer.succeed(CoreSandbox, upcastService(service)),
    Layer.succeed(SandboxHostnameAllowlist, undefined),
    Layer.succeed(SandboxSecretInjection, undefined),
    Layer.succeed(SandboxSnapshots, undefined),
    Layer.succeed(SandboxVolumes, undefined),
    Layer.succeed(SandboxPortExposure, undefined),
  )
}

// Re-export SDK error classes so consumers don't need a direct
// dependency on `@deno/sandbox` to do error-shape-narrowed handling.
export {
  ApiError,
  ConnectionClosedError,
  ConnectionEstablishmentError,
  InvalidMemoryError,
  InvalidTimeoutError,
  InvalidTokenError,
  MissingTokenError,
  SandboxCommandError,
  SandboxKillError,
}
