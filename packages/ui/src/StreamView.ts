/**
 * The client's view of a whole session stream: every run on it (several can
 * run at once) and its stream-scoped entries. A program stream (a station, a
 * radio) is mostly entries: a clip is `data { name: "clip", id: "3" }`, and a
 * repeated id updates it in place as it moves from planned to on air.
 *
 * `initial` + `step` plug into `Atoms.session` like `Thread`'s fold. `step`
 * is pure, total and idempotent on `seq`. With a contract's `P`, payloads are
 * decoded and `data` / `live` are typed by name.
 */
import type * as File from "@effect-uai/core/File"
import { Match } from "effect"
import {
  type Envelope,
  type Payloads,
  type RunEvent,
  type RunId,
  type StreamId,
  type Untyped,
} from "./RunEvent.js"
import * as RunView from "./RunView.js"

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

/** Stream-scoped `data` entries by name, then by id. A contract's names are optional keys. */
export type Entries<P extends Payloads = Untyped> = string extends P["data"]["name"]
  ? { readonly [name: string]: Readonly<Record<string, P["data"]["value"]>> }
  : { readonly [T in P["data"] as T["name"]]?: Readonly<Record<string, T["value"]>> }

/** A stream-scoped `media` entry. */
export type MediaEntry = { readonly source: File.FileSource; readonly name?: string }

export type StreamView<P extends Payloads = Untyped> = {
  /** The stream `lastSeq` counts in; a frame from another stream starts over. */
  readonly streamId: StreamId | null
  /** Highest applied `seq`; envelopes at or below it are ignored. */
  readonly lastSeq: number
  /** Every run seen, by id; `run-started.name` says which kind each is. */
  readonly runs: Readonly<Record<RunId, RunView.RunView<P>>>
  /** Run ids in the order their runs started. */
  readonly order: ReadonlyArray<RunId>
  readonly data: Entries<P>
  /** By `media.id`; one without an id gets its own `m<seq>` key. */
  readonly media: Readonly<Record<string, MediaEntry>>
  readonly live: RunView.Live<P>
}

export const initial: StreamView = {
  streamId: null,
  lastSeq: 0,
  runs: {},
  order: [],
  data: {},
  media: {},
  live: {},
}

/** {@link initial}, typed for a contract's `P`. */
export const empty = <P extends Payloads = Untyped>(): StreamView<P> => ({
  streamId: null,
  lastSeq: 0,
  runs: {},
  order: [],
  data: {} as Entries<P>,
  media: {},
  live: {} as RunView.Live<P>,
})

// ---------------------------------------------------------------------------
// Fold: written once over `Payloads`; the exported signature carries `P`.
// ---------------------------------------------------------------------------

type View = StreamView<Payloads>

const onRun = (v: View, runId: RunId, envelope: Envelope<Payloads>): View => {
  const current = v.runs[runId]
  const run: RunView.RunView<Payloads> = current ?? { ...RunView.initial }
  return {
    ...v,
    runs: { ...v.runs, [runId]: RunView.step(run, envelope) },
    order: current === undefined ? [...v.order, runId] : v.order,
  }
}

// Everything else has no stream-scoped meaning (`input-accepted` is a chat's).
const onStream = (v: View, event: RunEvent<Payloads>, seq: number): View =>
  Match.value(event).pipe(
    Match.discriminators("type")({
      data: (e): View => ({
        ...v,
        data: { ...v.data, [e.name]: { ...v.data[e.name], [e.id ?? `d${seq}`]: e.value } },
      }),
      media: (e): View => ({
        ...v,
        media: {
          ...v.media,
          [e.id ?? `m${seq}`]: { source: e.source, ...(e.name !== undefined && { name: e.name }) },
        },
      }),
      live: (e): View => ({ ...v, live: { ...v.live, [e.name]: e.value } }),
    }),
    Match.orElse(() => v),
  )

/**
 * Fold one envelope into the view. Run-scoped envelopes go to their run's
 * `RunView`; stream-scoped `data`, `media` and `live` land on the stream.
 */
export function step<P extends Payloads = Untyped>(
  view: StreamView<P>,
  envelope: Envelope<P>,
): StreamView<P>
export function step(view: View, envelope: Envelope<Payloads>): View {
  // `seq` is per stream: another stream is another program, so it starts from empty.
  const v: View =
    envelope.streamId === view.streamId
      ? view
      : { ...empty<Payloads>(), streamId: envelope.streamId }
  if (envelope.seq <= v.lastSeq) return view
  const next =
    envelope.runId === undefined
      ? onStream(v, envelope.event, envelope.seq)
      : onRun(v, envelope.runId, envelope)
  return { ...next, lastSeq: envelope.seq }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/** The runs in start order, optionally only those of one kind (`run-started.name`). */
export const runsOf = <P extends Payloads>(
  view: StreamView<P>,
  name?: string,
): ReadonlyArray<RunView.RunView<P>> =>
  view.order.flatMap((id) => {
    const run = view.runs[id]
    return run === undefined || (name !== undefined && run.name !== name) ? [] : [run]
  })
