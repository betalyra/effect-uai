/**
 * Framework-neutral state over a transport, built on `effect/reactivity`.
 * `make` takes any fold (`initial` + `step`); `thread` is the `Thread`
 * preset. React reads them with `@effect/atom-react` (`useAtomValue`,
 * `useAtomSet`), Vue and Solid with their official bindings, plain JS with
 * `AtomRegistry.subscribe`.
 *
 * With a `UiContract`, every envelope is decoded once on arrival, so the
 * state holds decoded payloads and is typed by the contract.
 */
import { Effect, Exit, Option, type Schema, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { Atom } from "effect/reactivity"
import * as Input from "./Input.js"
import type { Envelope, Payloads, StreamId, Untyped } from "./RunEvent.js"
import * as Thread from "./Thread.js"
import type * as Transport from "./Transport.js"
import type { UiContract } from "./UiContract.js"

/**
 * What `submit` does while a run is in flight. `"block"` ignores the new
 * input; `"stop-then-submit"` abandons the current run locally and starts
 * the new one (in durable mode the server-side run keeps going).
 */
export type Busy = "block" | "stop-then-submit"

/** Turns a wire envelope into what `step` folds (a contract's `decode`). */
export type Decode<D> = (envelope: Envelope) => Effect.Effect<D, Schema.SchemaError>

// `decode` may be left out only when `step` folds wire envelopes.
type WithDecode<D> = [Envelope] extends [D]
  ? { readonly decode?: Decode<D> }
  : { readonly decode: Decode<D> }

/**
 * `I` is the app's input type. `submit` takes a draft of it (`id` optional);
 * the transport receives it with the id assigned (`Input.Sent<I>`, a UUIDv7
 * from `SecureRandom`). `D` is the envelope `step` folds: the wire envelope,
 * or a contract's decoded one (then pass `decode`).
 */
type BaseOptions<I, S, E, R, ER, D> = {
  readonly runtime: Atom.AtomRuntime<R, ER>
  readonly transport: Transport.Transport<Input.Sent<I>, S, E, R>
  readonly initial: S
  readonly step: (state: S, envelope: D) => S
  readonly busy: Busy
  readonly isBusy?: (state: S) => boolean
  /** Optimistic update applied before the request goes out. */
  readonly submitted?: (state: S, input: Input.Sent<I>) => S
  /** Applied when a run's stream ends without its terminal. */
  readonly ended?: (state: S, reason: "stopped" | "disconnected") => S
}

export type Options<I, S, E, R, ER, D = Envelope> = BaseOptions<I, S, E, R, ER, D> & WithDecode<D>

const identity: Decode<Envelope> = Effect.succeed

const build = <I, S, E, R, ER, D>(
  options: BaseOptions<I, S, E, R, ER, D> & { readonly decode: Decode<D> },
) => {
  const state = Atom.make(options.initial).pipe(Atom.keepAlive)
  const streamId = Atom.make<StreamId | null>(null).pipe(Atom.keepAlive)

  const follow = (envelopes: Stream.Stream<Envelope, E, R>) =>
    envelopes.pipe(
      Stream.runForEach((envelope) =>
        options
          .decode(envelope)
          .pipe(
            Effect.flatMap((decoded) =>
              Atom.set(streamId, envelope.streamId).pipe(
                Effect.andThen(Atom.update(state, (s) => options.step(s, decoded))),
              ),
            ),
          ),
      ),
      Effect.onExit((exit) => {
        const ended = options.ended
        if (Exit.isSuccess(exit) || ended === undefined) return Effect.void
        const reason = Exit.hasInterrupts(exit) ? "stopped" : "disconnected"
        return Atom.update(state, (s) => ended(s, reason))
      }),
    )

  // Writing to a non-concurrent `Atom.fn` interrupts its previous run, so the
  // streaming lives in `run` and `submit` is a concurrent gate that applies
  // the busy policy before anything is interrupted. Every fn atom is kept
  // alive: an unobserved one is disposed, which interrupts its fiber.
  const run = options.runtime
    .fn<Input.Sent<I>>()((input) =>
      Effect.gen(function* () {
        const next = options.submitted?.(yield* Atom.get(state), input) ?? (yield* Atom.get(state))
        yield* Atom.set(state, next)
        yield* follow(options.transport.start(input, next))
      }),
    )
    .pipe(Atom.keepAlive)

  const submit = options.runtime
    .fn<Input.Draft<I>>()(
      (draft) =>
        Effect.gen(function* () {
          const blocked =
            options.busy === "block" && options.isBusy?.(yield* Atom.get(state)) === true
          if (blocked) return
          const input = yield* Input.withId(draft).pipe(Effect.provide(SecureRandom.layerWebCrypto))
          yield* Atom.set(run, input)
        }),
      { concurrent: true },
    )
    .pipe(Atom.keepAlive)

  // Durable: ask the server (its `run-stopped` arrives on the stream).
  // Direct: interrupt the request; `ended` settles the run locally.
  const stop = options.runtime
    .fn<void>()(() =>
      Effect.gen(function* () {
        const id = yield* Atom.get(streamId)
        const serverStop = options.transport.stop
        if (serverStop !== undefined && id !== null) return yield* serverStop(id)
        yield* Atom.set(run, Atom.Interrupt)
      }),
    )
    .pipe(Atom.keepAlive)

  const resume = options.transport.resume
  const attach =
    resume === undefined
      ? undefined
      : options.runtime
          .fn<{ readonly streamId: StreamId; readonly after: number }>()((arg) =>
            follow(resume(arg.streamId, arg.after)),
          )
          .pipe(Atom.keepAlive)

  return {
    state,
    streamId,
    submit,
    /** The current run; `AtomRegistry.getResult` on it waits for the run to finish. */
    run,
    stop,
    /** Re-attach to a run (`{ streamId, after }`); set for durable transports. */
    resume: attach,
  }
}

type Built<I, S, E, R, ER> = ReturnType<typeof build<I, S, E, R, ER, unknown>>

/**
 * State over a per-run transport: `state`, `submit`, `stop`, `run`, and
 * `resume` when the transport can re-attach (`Transport.durable`,
 * `durableHttp`), typed as present for those.
 */
export function make<I, S, E, R, ER, D = Envelope>(
  options: Options<I, S, E, R, ER, D> & {
    readonly transport: Transport.Resumable<Input.Sent<I>, S, E, R>
  },
): Omit<Built<I, S, E, R, ER>, "resume"> & {
  readonly resume: NonNullable<Built<I, S, E, R, ER>["resume"]>
}
export function make<I, S, E, R, ER, D = Envelope>(
  options: Options<I, S, E, R, ER, D>,
): Built<I, S, E, R, ER>
export function make<I, S, E, R, ER>(
  options: Options<I, S, E, R, ER, Envelope>,
): Built<I, S, E, R, ER> {
  return build({ ...options, decode: options.decode ?? identity })
}

type ThreadOptions<I, E, R, ER, P extends Payloads> = {
  readonly runtime: Atom.AtomRuntime<R, ER>
  readonly transport: Transport.Transport<Input.Sent<I>, Thread.Thread<P>, E, R>
  readonly busy: Busy
  readonly initial?: Thread.Thread<P>
}

/**
 * `make` with the `Thread` preset: a message list plus the active run. Takes
 * the `Input` preset, with or without typed `data`. With `contract`, the
 * state is typed by it. For other entry types, spread a `Thread.make(config)`
 * fold into `make`.
 */
export function thread<I extends Input.Input, E, R, ER, P extends Payloads>(
  options: ThreadOptions<I, E, R, ER, P> & { readonly contract: UiContract<P> },
): Built<I, Thread.Thread<P>, E, R, ER>
export function thread<I extends Input.Input, E, R, ER>(
  options: ThreadOptions<I, E, R, ER, Untyped>,
): Built<I, Thread.Thread, E, R, ER>
// The implementation sees `P` as `any`: the options both read and receive
// `Thread<P>`, so no single `P` fits both overloads. Callers get the overloads.
export function thread<I extends Input.Input, E, R, ER>(
  options: ThreadOptions<I, E, R, ER, any> & { readonly contract?: UiContract<any> },
): Built<I, Thread.Thread<any>, E, R, ER> {
  const fold = Thread.presetFor<any>()
  return build({
    runtime: options.runtime,
    transport: options.transport,
    busy: options.busy,
    initial: options.initial ?? fold.initial,
    step: fold.step,
    decode: options.contract?.decode ?? identity,
    isBusy: (t) => t.active !== null,
    submitted: (t, input: Input.Sent<I>) => fold.submitted(t, input),
    ended: fold.ended,
  })
}

// ---------------------------------------------------------------------------
// Sessions: one stream carries every run (a durable chat)
// ---------------------------------------------------------------------------

type BaseSessionOptions<I, S, E, R, ER, D> = {
  readonly runtime: Atom.AtomRuntime<R, ER>
  readonly transport: Transport.Session<Input.Sent<I>, S, E, R>
  readonly initial: S
  readonly step: (state: S, envelope: D) => S
  /** While true, `submit` ignores new input (the server may also refuse). */
  readonly isBusy?: (state: S) => boolean
  /** Optimistic update applied before the input is sent. */
  readonly submitted?: (state: S, input: Input.Sent<I>) => S
  /** Applied when sending fails or the session's stream gives up. */
  readonly ended?: (state: S, reason: "stopped" | "disconnected") => S
}

export type SessionOptions<I, S, E, R, ER, D = Envelope> = BaseSessionOptions<I, S, E, R, ER, D> &
  WithDecode<D>

const buildSession = <I, S, E, R, ER, D>(
  options: BaseSessionOptions<I, S, E, R, ER, D> & { readonly decode: Decode<D> },
) => {
  const state = Atom.make(options.initial).pipe(Atom.keepAlive)
  const streamId = Atom.make<StreamId | null>(null).pipe(Atom.keepAlive)

  const settle = (exit: Exit.Exit<unknown, unknown>) => {
    const ended = options.ended
    return ended === undefined || Exit.isSuccess(exit) || Exit.hasInterrupts(exit)
      ? Effect.void
      : Atom.update(state, (s) => ended(s, "disconnected"))
  }

  // Non-concurrent: opening another session stops following the previous one.
  const open = options.runtime
    .fn<StreamId>()((id) =>
      Atom.set(streamId, id).pipe(
        Effect.andThen(
          options.transport
            .events(id, 0)
            .pipe(
              Stream.runForEach((envelope) =>
                options
                  .decode(envelope)
                  .pipe(
                    Effect.flatMap((decoded) =>
                      Atom.update(state, (s) => options.step(s, decoded)),
                    ),
                  ),
              ),
            ),
        ),
        Effect.onExit(settle),
      ),
    )
    .pipe(Atom.keepAlive)

  const submit = options.runtime
    .fn<Input.Draft<I>>()(
      (draft) =>
        Effect.gen(function* () {
          if (options.isBusy?.(yield* Atom.get(state)) === true) return
          const input = yield* Input.withId(draft).pipe(Effect.provide(SecureRandom.layerWebCrypto))
          const current = yield* Atom.get(state)
          const next = options.submitted?.(current, input) ?? current
          yield* Atom.set(state, next)
          const open_ = Option.fromNullishOr(yield* Atom.get(streamId))
          const sent = yield* options.transport.send(open_, input, next)
          if (Option.isNone(open_)) yield* Atom.set(open, sent.streamId)
        }).pipe(Effect.onExit(settle)),
      { concurrent: true },
    )
    .pipe(Atom.keepAlive)

  // The server stops the active run; its `run-stopped` arrives on the stream.
  const stop = options.runtime
    .fn<void>()(() =>
      Effect.gen(function* () {
        const id = yield* Atom.get(streamId)
        const serverStop = options.transport.stop
        if (serverStop !== undefined && id !== null) yield* serverStop(id)
      }),
    )
    .pipe(Atom.keepAlive)

  return { state, streamId, open, submit, stop }
}

type BuiltSession<I, S, E, R, ER> = ReturnType<typeof buildSession<I, S, E, R, ER, unknown>>

/**
 * State over a session transport. `open(streamId)` follows a session's
 * stream from its start (e.g. a chat id kept across reloads). `submit` sends
 * an input; without an open session the server starts one, which is then
 * opened. Runs arrive on the followed stream, not as responses to `submit`.
 */
export function session<I, S, E, R, ER, D = Envelope>(
  options: SessionOptions<I, S, E, R, ER, D>,
): BuiltSession<I, S, E, R, ER>
export function session<I, S, E, R, ER>(
  options: SessionOptions<I, S, E, R, ER, Envelope>,
): BuiltSession<I, S, E, R, ER> {
  return buildSession({ ...options, decode: options.decode ?? identity })
}

type ChatOptions<I, E, R, ER, P extends Payloads> = {
  readonly runtime: Atom.AtomRuntime<R, ER>
  readonly transport: Transport.Session<Input.Sent<I>, Thread.Thread<P>, E, R>
  readonly isBusy?: (thread: Thread.Thread<P>) => boolean
}

/**
 * `session` with the `Thread` preset. Input sent while a run is active, or
 * echoed by the server (`input-accepted`), waits in `thread.pending`: the
 * server queues it. Pass `isBusy` for a server that refuses instead. With
 * `contract`, the state is typed by it. For other entry types, spread a
 * `Thread.make(config)` fold into `session`.
 */
export function chat<I extends Input.Input, E, R, ER, P extends Payloads>(
  options: ChatOptions<I, E, R, ER, P> & { readonly contract: UiContract<P> },
): BuiltSession<I, Thread.Thread<P>, E, R, ER>
export function chat<I extends Input.Input, E, R, ER>(
  options: ChatOptions<I, E, R, ER, Untyped>,
): BuiltSession<I, Thread.Thread, E, R, ER>
// `any` for `P` in the implementation only, as in `thread`.
export function chat<I extends Input.Input, E, R, ER>(
  options: ChatOptions<I, E, R, ER, any> & { readonly contract?: UiContract<any> },
): BuiltSession<I, Thread.Thread<any>, E, R, ER> {
  const fold = Thread.presetFor<any>()
  return buildSession({
    runtime: options.runtime,
    transport: options.transport,
    initial: fold.initial,
    step: fold.step,
    decode: options.contract?.decode ?? identity,
    ...(options.isBusy !== undefined ? { isBusy: options.isBusy } : {}),
    submitted: (t, input: Input.Sent<I>) => fold.submitted(t, input),
    ended: fold.ended,
  })
}
