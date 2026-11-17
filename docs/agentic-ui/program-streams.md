---
title: Program streams
description: "Beyond chat: a station, a generation queue or a dashboard as one session stream of entries that update in place, several runs at once, and media the browser plays."
---

A chat is a thread of runs. Plenty of apps are not: a TV station planning
and rendering clips, a radio generating tracks ahead of the listener, a
queue of video jobs, a dashboard. What the browser needs there is a set of
**entries** that change in place (clip 3: queued, then rendering, then on
air), the odd **run** next to them, and **media** to play.

`@effect-uai/ui` covers this with the same session transport as a durable
chat and one more fold, `StreamView`.

## Entries that update in place

A stream-scoped `data` event with an `id` is an entry; a repeated id
replaces it. Type the entries with a contract, as for tools:

```ts
// contract.ts: imported by server and client
export const ClipEntry = Schema.Struct({
  index: Schema.Number,
  title: Schema.String,
  render: Schema.optionalKey(Job.JobStateSchema(Schema.Struct({}), Schema.String)),
})

export const StationUi = UiContract.make({
  data: { clip: ClipEntry },
  live: { screen: Screen }, // latest wins: what is on air now
})
```

On the server, every update is one event:

```ts
StationUi.data("clip", { index: 3, title, render: state }, { id: "3" })
```

`Job.JobStateSchema(result, error)` puts a background job's state on the
wire, so a `VideoGenerator.watch` stream maps straight onto an entry: each
polled state (queued with its position, running, done, failed) replaces the
last. You choose how a failure is encoded, since `AiError` has no schema.

## Media

`media` carries audio, video or a file, by URL, base64 or bytes; the MIME
type says which. A repeated `id` replaces it too.

```ts
const clip: RunEvent = {
  type: "media",
  id: "clip-3",
  name: title,
  source: { _tag: "url", url: "/clips/clip-3.mp4", mimeType: "video/mp4" },
}
```

Send a URL your server serves for anything but small files. A provider's
file `ref` (a Gemini clip, say) does not fit the event at all: reading it
needs the provider's key, so the server streams it (`VideoGenerator.toStream`)
or copies it to your own storage first.

## Several runs at once

`Run.sequence` takes the run id from the last `run-started`, so runs merged
before it would be mislabelled. Tag each run's events with its id, merge,
then number them once:

```ts
Stream.merge(
  planner.pipe(Run.start({ runId: p, name: "planner" }), Run.complete, Run.within(p)),
  program.pipe(Run.start({ runId: q, name: "program" }), Run.complete, Run.within(q)),
).pipe(
  Stream.merge(Run.streamScoped(entries)), // data, media and live outside any run
  Run.sequenceOwned(streamId),
)
```

## In the browser: `StreamView`

`StreamView` folds a whole session stream: every run by id in start order,
the `data` entries by name and id, the `media`, and `live`. It is pure and
idempotent on `seq`, and plugs into `Atoms.session` like `Thread` does:

```ts
const station = Atoms.session({
  runtime,
  transport: Transport.reconnect(Transport.sessionHttp({ send, events })),
  initial: StreamView.empty<UiContract.Payloads<typeof StationUi>>(),
  step: StreamView.step,
  decode: StationUi.decode,
})

registry.subscribe(station.state, (view) => {
  view.data.clip?.["3"]?.render?._tag // "Pending" | "Running" | "Succeeded" | "Failed"
  view.media["clip-3"]?.source // what to play
  view.live.screen // what is on air
  StreamView.runsOf(view, "planner") // the planner's runs, as RunViews
})
```

## A program that outlives the tab

Run the program in a fiber scoped to your server, not in a request, and
publish its envelopes into a `PubSub` that replays from the start. Every
page follows the same stream; a reload gets the whole state, then the live
updates. Start it on an input (a Play button) so nothing is spent until
someone asks.

The [TV station](/recipes/tv-station/) and
[Radio station](/recipes/radio-station/) recipes are both built this
way: the TV with render progress per clip and a shared live picture, the
radio with tracks generated one ahead of the listener.
