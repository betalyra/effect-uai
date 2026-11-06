/**
 * Framework-neutral state over a transport, built on `effect/reactivity`.
 * `make` takes any fold (`initial` + `step`); `thread` is the `Thread`
 * preset. React reads them with `@effect/atom-react` (`useAtomValue`,
 * `useAtomSet`), Vue and Solid with their official bindings, plain JS with
 * `AtomRegistry.subscribe`.
 */
import { Effect, Exit, Option, Stream } from "effect"
import { SecureRandom } from "effect/crypto"
import { Atom } from "effect/reactivity"
import * as Input from "./Input.js"
import type { Envelope, StreamId } from "./RunEvent.js"
import * as Thread from "./Thread.js"
import type * as Transport from "./Transport.js"

/**
 * What `submit` does while a run is in flight. `"block"` ignores the new
 * input; `"stop-then-submit"` abandons the current run locally and starts
 * the new one (in durable mode the server-side run keeps going).
 */
export type Busy = "block" | "stop-then-submit"

/**
 * `I` is the app's input type. `submit` takes a draft of it (`id` optional);
 * the transport receives it with the id assigned (`Input.Sent<I>`, a UUIDv7
 * from `SecureRandom`).
 */
export type Options<I, S, E, R, ER> = {
  readonly runtime: Atom.AtomRuntime<R, ER>
  readonly transport: Transport.Transport<Input.Sent<I>, S, E, R>
  readonly initial: S
  readonly step: (state: S, envelope: Envelope) => S
  readonly busy: Busy
  readonly isBusy?: (state: S) => boolean
  /** Optimistic update applied before the request goes out. */
  readonly submitted?: (state: S, input: Input.Sent<I>) => S
  /** Applied when a run's stream ends without its terminal. */
  readonly ended?: (state: S, reason: "stopped" | "disconnected") => S
}

const build = <I, S, E, R, ER>(options: Options<I, S, E, R, ER>) => {
  const state = Atom.make(options.initial).pipe(Atom.keepAlive)
  const streamId = Atom.make<StreamId | null>(null).pipe(Atom.keepAlive)

  const follow = (envelopes: Stream.Stream<Envelope, E, R>) =>
    envelopes.pipe(
      Stream.runForEach((envelope) =>
        Atom.set(streamId, envelope.streamId).pipe(
          Effect.andThen(Atom.update(state, (s) => options.step(s, envelope))),
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

type Built<I, S, E, R, ER> = ReturnType<typeof build<I, S, E, R, ER>>

/**
 * State over a per-run transport: `state`, `submit`, `stop`, `run`, and
 * `resume` when the transport can re-attach (`Transport.durable`,
 * `durableHttp`), typed as present for those.
 */
export function make<I, S, E, R, ER>(
  options: Options<I, S, E, R, ER> & {
    readonly transport: Transport.Resumable<Input.Sent<I>, S, E, R>
  },
): Omit<Built<I, S, E, R, ER>, "resume"> & {
  readonly resume: NonNullable<Built<I, S, E, R, ER>["resume"]>
}
export function make<I, S, E, R, ER>(options: Options<I, S, E, R, ER>): Built<I, S, E, R, ER>
export function make<I, S, E, R, ER>(options: Options<I, S, E, R, ER>): Built<I, S, E, R, ER> {
  return build(options)
}

/**
 * `make` with the `Thread` preset: a message list plus the active run. Takes
 * the `Input` preset, with or without typed `data`. For other entry types,
 * spread a `Thread.make(config)` fold into `make`.
 */
export const thread = <I extends Input.Input, E, R, ER>(options: {
  readonly runtime: Atom.AtomRuntime<R, ER>
  readonly transport: Transport.Transport<Input.Sent<I>, Thread.Thread, E, R>
  readonly busy: Busy
  readonly initial?: Thread.Thread
}) =>
  make({
    runtime: options.runtime,
    transport: options.transport,
    busy: options.busy,
    initial: options.initial ?? Thread.initial,
    step: Thread.step,
    isBusy: (t) => t.active !== null,
    submitted: (t: Thread.Thread, input: Input.Sent<I>) => Thread.submitted(t, input),
    ended: Thread.ended,
  })

// ---------------------------------------------------------------------------
// Sessions: one stream carries every run (a durable chat)
// ---------------------------------------------------------------------------

export type SessionOptions<I, S, E, R, ER> = {
  readonly runtime: Atom.AtomRuntime<R, ER>
  readonly transport: Transport.Session<Input.Sent<I>, S, E, R>
  readonly initial: S
  readonly step: (state: S, envelope: Envelope) => S
  /** While true, `submit` ignores new input (the server may also refuse). */
  readonly isBusy?: (state: S) => boolean
  /** Optimistic update applied before the input is sent. */
  readonly submitted?: (state: S, input: Input.Sent<I>) => S
  /** Applied when sending fails or the session's stream gives up. */
  readonly ended?: (state: S, reason: "stopped" | "disconnected") => S
}

/**
 * State over a session transport. `open(streamId)` follows a session's
 * stream from its start (e.g. a chat id kept across reloads). `submit` sends
 * an input; without an open session the server starts one, which is then
 * opened. Runs arrive on the followed stream, not as responses to `submit`.
 */
export const session = <I, S, E, R, ER>(options: SessionOptions<I, S, E, R, ER>) => {
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
              Stream.runForEach((envelope) => Atom.update(state, (s) => options.step(s, envelope))),
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

/**
 * `session` with the `Thread` preset. Input sent while a run is active, or
 * echoed by the server (`input-accepted`), waits in `thread.pending`: the
 * server queues it. Pass `isBusy` for a server that refuses instead. For
 * other entry types, spread a `Thread.make(config)` fold into `session`.
 */
export const chat = <I extends Input.Input, E, R, ER>(options: {
  readonly runtime: Atom.AtomRuntime<R, ER>
  readonly transport: Transport.Session<Input.Sent<I>, Thread.Thread, E, R>
  readonly isBusy?: (thread: Thread.Thread) => boolean
}) =>
  session({
    runtime: options.runtime,
    transport: options.transport,
    initial: Thread.initial,
    step: Thread.step,
    ...(options.isBusy !== undefined ? { isBusy: options.isBusy } : {}),
    submitted: (t: Thread.Thread, input: Input.Sent<I>) => Thread.submitted(t, input),
    ended: Thread.ended,
  })
