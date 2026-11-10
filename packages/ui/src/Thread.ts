/**
 * Optional chat model on top of `RunView`: a message list, the run that is
 * still streaming, and inputs waiting for their run. `make` builds the fold
 * for any entry types; the module's own exports are the default preset
 * (user entries hold the input's messages, assistant entries the `RunView`).
 *
 * A fold's fields (`initial`, `step`, `submitted`, `ended`) are what
 * `Atoms.session` and `Atoms.make` take, so `{ ...Thread.make(config) }`
 * plugs in directly.
 *
 * A settled assistant entry with a call awaiting approval still changes when
 * that call is answered (`updateTool`): save entries when they change, not
 * only when they settle.
 */
import { Array as Arr, Option, Schema } from "effect"
import * as Input from "./Input.js"
import { type Envelope, InputId, type Payloads, StreamId, type Untyped } from "./RunEvent.js"
import * as RunView from "./RunView.js"

// ---------------------------------------------------------------------------
// Generic fold
// ---------------------------------------------------------------------------

export type UserEntry<U> = { readonly role: "user"; readonly id: InputId; readonly value: U }
export type AssistantEntry<A> = {
  readonly role: "assistant"
  readonly id: string
  readonly value: A
}
export type Entry<U, A> = UserEntry<U> | AssistantEntry<A>

/** `P` types the active run's payloads (see `UiContract`). */
export type State<U, A, P extends Payloads = Untyped> = {
  readonly messages: ReadonlyArray<Entry<U, A>>
  /** The run still streaming, if any. */
  readonly active: RunView.RunView<P> | null
  /**
   * Inputs waiting for their own run (sent during a run, or echoed by a
   * server that queues). They join `messages` when a `run-started` lists them.
   */
  readonly pending: ReadonlyArray<UserEntry<U>>
  /** The stream `lastSeq` counts in; a frame from another stream starts a new count. */
  readonly streamId: StreamId | null
  /** Highest applied `seq` across runs, so a settled run's frames stay deduplicated. */
  readonly lastSeq: number
}

/**
 * The state as a Schema, for persisting or sending it. `view` is the active
 * run's schema: `RunView.RunView` (default) or a contract's `RunView`.
 */
export const State = <U, A, V>(
  user: Schema.Codec<U, unknown, never, never>,
  assistant: Schema.Codec<A, unknown, never, never>,
  view: Schema.Codec<V, unknown, never, never>,
) => {
  const UserEntry = Schema.Struct({ role: Schema.Literal("user"), id: InputId, value: user })
  const AssistantEntry = Schema.Struct({
    role: Schema.Literal("assistant"),
    id: Schema.String,
    value: assistant,
  })
  return Schema.Struct({
    messages: Schema.Array(Schema.Union([UserEntry, AssistantEntry])),
    active: Schema.NullOr(view),
    pending: Schema.Array(UserEntry),
    streamId: Schema.NullOr(StreamId),
    lastSeq: Schema.Number,
  })
}

export type Config<I, U, A, P extends Payloads = Untyped> = {
  /** The user entry for an input; `None` for inputs without one (approvals). */
  readonly toUser: (input: I) => Option.Option<U>
  /** The assistant entry a finished run settles into. */
  readonly settle: (run: RunView.RunView<P>) => A
  /** Decodes an `input-accepted` echo into an input; without it, echoes are ignored. */
  readonly decodeInput?: (value: unknown) => Option.Option<I>
  /**
   * Applies a tool event to a settled entry that holds the call (`None` if it
   * doesn't). An approved call's result arrives in the next run; with this,
   * it updates the card it was asked from. Without it, it lands in the new run.
   */
  readonly updateTool?: (entry: A, event: RunView.ToolUpdate<P>) => Option.Option<A>
}

export type Fold<I, U, A, P extends Payloads = Untyped> = {
  readonly initial: State<U, A, P>
  readonly step: (state: State<U, A, P>, envelope: Envelope<P>) => State<U, A, P>
  /** Optimistic: show the input before the server answers. */
  readonly submitted: (state: State<U, A, P>, input: I) => State<U, A, P>
  /** Settle the active run when its stream ends without a terminal. */
  readonly ended: (state: State<U, A, P>, reason: "stopped" | "disconnected") => State<U, A, P>
}

/** Whether the state already shows the input `id` (settled or pending). */
export const hasInput = <U, A, P extends Payloads>(state: State<U, A, P>, id: InputId): boolean =>
  state.messages.some((m) => m.role === "user" && m.id === id) ||
  state.pending.some((m) => m.id === id)

/** Drop everything after the entry `id` (regenerate, edit). */
export const truncateAfter = <U, A, P extends Payloads>(
  state: State<U, A, P>,
  id: string,
): State<U, A, P> => {
  const index = state.messages.findIndex((m) => m.id === id)
  return index === -1
    ? state
    : { ...state, messages: state.messages.slice(0, index + 1), active: null }
}

// Written once over `Payloads`; the exported signature carries the caller's `P`.
export function make<I extends { readonly id: InputId }, U, A, P extends Payloads = Untyped>(
  config: Config<I, U, A, P>,
): Fold<I, U, A, P>
export function make<I extends { readonly id: InputId }, U, A>(
  config: Config<I, U, A, Payloads>,
): Fold<I, U, A, Payloads> {
  type S = State<U, A, Payloads>

  const initial: S = { messages: [], active: null, pending: [], streamId: null, lastSeq: 0 }

  const settled = (run: RunView.RunView<Payloads>, fallbackSeq: number): AssistantEntry<A> => ({
    role: "assistant",
    id: run.runId ?? `seq-${fallbackSeq}`,
    value: config.settle(run),
  })

  // `seq` is per stream: a run on a new stream (one stream per run) counts from 1 again.
  const onStream = (state: S, envelope: Envelope<Payloads>): S =>
    envelope.streamId === state.streamId
      ? state
      : {
          ...state,
          streamId: envelope.streamId,
          lastSeq: 0,
          active: state.active === null ? null : { ...state.active, lastSeq: 0 },
        }

  // A starting run takes its inputs out of `pending`, so they sit above its answer.
  const consume = (state: S, envelope: Envelope<Payloads>): S => {
    const event = envelope.event
    if (event.type !== "run-started" || state.pending.length === 0) return state
    const taken = (m: UserEntry<U>) => event.inputs.includes(m.id)
    return {
      ...state,
      messages: [...state.messages, ...state.pending.filter(taken)],
      pending: state.pending.filter((m) => !taken(m)),
    }
  }

  // The server's echo of an input it accepted: shown as pending unless already shown.
  const accepted = (state: S, value: unknown): S =>
    Option.fromNullishOr(config.decodeInput).pipe(
      Option.flatMap((decode) => decode(value)),
      Option.filter((input) => !hasInput(state, input.id)),
      Option.flatMap((input) =>
        config
          .toUser(input)
          .pipe(Option.map((u): UserEntry<U> => ({ role: "user", id: input.id, value: u }))),
      ),
      Option.match({
        onNone: () => state,
        onSome: (entry) => ({ ...state, pending: [...state.pending, entry] }),
      }),
    )

  const submitted = (state: S, input: I): S => {
    const idle = state.active === null
    const run: RunView.RunView<Payloads> = {
      ...RunView.initial,
      status: "submitted",
      lastSeq: state.lastSeq,
    }
    return Option.match(config.toUser(input), {
      onNone: () => (idle ? { ...state, active: run } : state),
      onSome: (u): S => {
        const entry: UserEntry<U> = { role: "user", id: input.id, value: u }
        return idle
          ? { ...state, messages: [...state.messages, entry], active: run }
          : { ...state, pending: [...state.pending, entry] }
      },
    })
  }

  // The latest settled entry that holds the call, updated by `config.updateTool`.
  const updateSettled = (
    messages: ReadonlyArray<Entry<U, A>>,
    event: RunView.ToolUpdate<Payloads>,
  ): Option.Option<ReadonlyArray<Entry<U, A>>> =>
    Option.fromNullishOr(config.updateTool).pipe(
      Option.flatMap((update) =>
        Arr.findLast(messages, (m, index) =>
          m.role === "assistant"
            ? update(m.value, event).pipe(
                Option.map((value) => ({ index, entry: { ...m, value } })),
              )
            : Option.none(),
        ),
      ),
      Option.map(({ index, entry }) =>
        messages.map((m, i): Entry<U, A> => (i === index ? entry : m)),
      ),
    )

  const step = (current: S, envelope: Envelope<Payloads>): S => {
    const fresh = onStream(current, envelope)
    if (envelope.seq <= fresh.lastSeq) return current
    const state = consume(fresh, envelope)
    const event = envelope.event
    if (event.type === "input-accepted")
      return { ...accepted(state, event.input), lastSeq: envelope.seq }
    // Stream-scoped frames (no `runId`) and frames outside a run are not a run's content.
    if (envelope.runId === undefined || (state.active === null && event.type !== "run-started")) {
      return { ...state, lastSeq: envelope.seq }
    }
    // A call made in an earlier run (approved after it was interrupted) updates that run.
    if (RunView.isToolUpdate(event)) {
      const updated = updateSettled(state.messages, event)
      if (Option.isSome(updated))
        return { ...state, messages: updated.value, lastSeq: envelope.seq }
    }
    const active: RunView.RunView<Payloads> = state.active ?? {
      ...RunView.initial,
      lastSeq: state.lastSeq,
    }
    const run = RunView.step(active, envelope)
    if (!RunView.isTerminal(run)) return { ...state, active: run, lastSeq: envelope.seq }
    return {
      ...state,
      messages: [...state.messages, settled(run, envelope.seq)],
      active: null,
      lastSeq: envelope.seq,
    }
  }

  const ended = (state: S, reason: "stopped" | "disconnected"): S => {
    const run = state.active
    if (run === null) return state
    const final: RunView.RunView<Payloads> =
      reason === "stopped"
        ? { ...run, status: "stopped" }
        : { ...run, status: "failed", error: { reason: "disconnected" } }
    return { ...state, messages: [...state.messages, settled(final, state.lastSeq)], active: null }
  }

  return { initial, step, submitted, ended }
}

// ---------------------------------------------------------------------------
// Default preset: user entries hold the input's messages, assistant entries the run
// ---------------------------------------------------------------------------

/** A user entry's value in the preset: the messages the input carried. */
export const UserContent = Schema.Struct({ messages: Schema.Array(Input.UserMessage) })
export type UserContent = typeof UserContent.Type

export const Thread = State(UserContent, RunView.RunView, RunView.RunView)
/** The preset's state; with a contract's `P`, runs carry decoded payloads. */
export type Thread<P extends Payloads = Untyped> = State<UserContent, RunView.RunView<P>, P>
export type Message<P extends Payloads = Untyped> = Entry<UserContent, RunView.RunView<P>>

/** Inputs the preset understands: any with an id; those with messages get a user entry. */
export type PresetInput = {
  readonly id: InputId
  readonly messages?: ReadonlyArray<Input.UserMessage>
}

/** The preset's fold for a contract's `P` (`UiContract` and `Atoms` use it). */
export const presetFor = <P extends Payloads = Untyped>(): Fold<
  PresetInput,
  UserContent,
  RunView.RunView<P>,
  P
> =>
  make<PresetInput, UserContent, RunView.RunView<P>, P>({
    toUser: (input) =>
      Option.fromNullishOr(input.messages).pipe(Option.map((messages) => ({ messages }))),
    settle: (run) => run,
    decodeInput: Schema.decodeUnknownOption(Input.InputJson),
    updateTool: RunView.applyToolUpdate,
  })

export const preset = presetFor()

export const { initial, step, submitted, ended } = preset
