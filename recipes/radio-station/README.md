---
title: Radio station
description: Run your own AI radio station. An AI DJ writes the next track while the current one streams; the same set replays for free after the first pass.
source: recipes/radio-station
icon: PiRadio
---

An AI radio station is a DJ that writes each track just before it plays.

You give it a one-line brief — say `"late-night lo-fi study session"`
— and the DJ writes the first track. While that track streams to
your speakers, the DJ is already writing and generating the next
one. By the time the current track ends, the next is ready to play.
After 10 tracks the station loops; from then on the same set replays
straight from disk, free.

**Scenario.** Open a tab, click **Start**, listen. First track plays
after a few seconds. Tracks keep coming back-to-back — no gap, no
manual queueing, no upfront wait for the full playlist. Cycle through
twice and the second pass costs nothing.

## The shape

```
[brief]
  │
  ▼  plan track 0 (LLM, one call)
{ title, prompt }
  │
  ▼  generation pipeline
                ┌────────────────────────────────────────────────────┐
                │ prefetch fiber: plan track N+1 → gen track N+1 → disk │
                └────────────────────────────────────────────────────┘
                ┌────────────────────────────────────────────────────┐
                │ sender:      track N stream chunks → WS              │
                └────────────────────────────────────────────────────┘
  │
  ▼  WebSocket (MP3 binary + JSON control frames)
[browser] MediaSource ← appendBuffer ← chunk → <audio> → speakers
```

## End-to-end streaming

`trackStream(plan, i, dir)` returns a `Stream<Uint8Array>`. It never
drains itself. Cache policy lives inside:

```ts
const trackStream = (plan, i, tracksDir, musicModel) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const file = `${tracksDir}/track-${i}.mp3`
      if (yield* Effect.promise(() => Bun.file(file).exists())) {
        return Stream.fromReadableStream({
          evaluate: () => Bun.file(file).stream(),
          onError: ...,
        })
      }
      // Open a Bun FileSink scoped to the stream's lifetime. On success
      // the `.partial` file is renamed; on failure / interrupt it's
      // unlinked so the next attempt doesn't read a half-written file.
      const writer = yield* Effect.acquireRelease(
        Effect.sync(() => Bun.file(`${file}.partial`).writer()),
        (w, exit) => Effect.promise(async () => {
          await w.end()
          if (Exit.isSuccess(exit)) await rename(`${file}.partial`, file)
          else await unlink(`${file}.partial`).catch(() => {})
        }),
      )
      return MusicGenerator.streamGeneration({...}).pipe(
        Stream.map((c) => c.bytes),
        Stream.tap((bytes) => Effect.sync(() => writer.write(bytes))),
      )
    }),
  )
```

Two consumers, neither inside the producer:

```ts
// Foreground: chunk → WS, every byte flows the moment it arrives.
const sendToClient = (plan, i, cycle, cfg) =>
  trackStream(plan, i, cfg.tracksDir, cfg.musicModel).pipe(
    Stream.tap(cfg.sendBytes),
    Stream.runDrain,
  )

// Background: same stream, no destination. Cache side effect only.
const prefetchToDisk = (plan, i, tracksDir, musicModel) =>
  trackStream(plan, i, tracksDir, musicModel).pipe(Stream.runDrain)
```

## Just-in-time planning

The planner is one LLM call per track, not one per station. Plan 0
runs upfront so there's something to play; plans 1..N-1 run inside the
prefetch fiber for the next track, racing against the music gen of the
current one.

```ts
yield* Effect.forever(
  Effect.gen(function* () {
    const { cycle, idx } = yield* Ref.get(state)

    // 1. Wait for THIS track's prefetch (plan + gen) to land.
    yield* Ref.get(prefetch).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Fiber.join })),
    )

    // 2. Kick prefetch for the NEXT track: plan (cycle 0 only) + gen.
    const nextIdx = (idx + 1) % cfg.trackCount
    const fiber = yield* Effect.forkChild(
      Effect.gen(function* () {
        const soFar = yield* Ref.get(plans)
        if (nextIdx >= soFar.length) {
          const plan = yield* planTrack(cfg.brief, nextIdx, cfg.trackCount, soFar, cfg.plannerModel)
          yield* Ref.update(plans, (ps) => [...ps, plan])
          yield* cfg.send({ type: "track-planned", index: nextIdx, title: plan.title })
        }
        const ps = yield* Ref.get(plans)
        yield* prefetchToDisk(ps[nextIdx]!, nextIdx, cfg.tracksDir, cfg.musicModel)
      }),
    )
    yield* Ref.set(prefetch, Option.some(fiber))

    // 3. Stream THIS track to the client.
    const ps = yield* Ref.get(plans)
    yield* sendToClient(ps[idx]!, idx, cycle, cfg)

    // 4. Backpressure on actual listening time.
    yield* cfg.waitTrackEnded

    yield* Ref.set(state, { cycle: nextIdx === 0 ? cycle + 1 : cycle, idx: nextIdx })
  }),
)
```

`waitTrackEnded` is a per-connection `Queue.take`; the WS message
handler offers to it when the browser posts `{type:"track-ended"}`
(sent when the `<audio>`'s `currentTime` crosses the track's end
position in the MediaSource buffer).

## Run it

```sh
OPENAI_API_KEY=...     # planner (Responses)
ELEVENLABS_API_KEY=... # music (ElevenLabs Music) — default
GOOGLE_API_KEY=...     # music (Google Lyria) — alternative

# ElevenLabs (default, native chunked streaming, full-length tracks)
bun recipes/radio-station/run-bun.ts

# Google Lyria (30s clips, fake streaming — same pipeline)
PROVIDER=google bun recipes/radio-station/run-bun.ts

# Custom brief, custom track count
STATION_BRIEF="synthwave roadtrip, neon and fast" \
TRACK_COUNT=8 \
  bun recipes/radio-station/run-bun.ts
```

Open `http://localhost:3000`, click **Start**. Tracks land in
`recipes/radio-station/tracks/{provider}/` (gitignored via `*.mp3`).
Delete the per-provider folder to force fresh generation with a new
plan; tracks are reused across runs.

## Cost shape

- **Cycle 0**: N+1 small planner calls (one upfront + one per
  prefetched track) + N music generations.
- **Cycle 1+**: zero. The plan list and the audio files are both
  cached.
- **Pipeline depth**: max 2 generations in flight at any time (one
  for the sender, one prefetch). Bounded by `Fiber.join` at the top
  of each loop iteration.

## What this generalises to

The producer / consumer / prefetcher split is the pattern any time
you want to stream a generated resource to a live consumer while
caching the bytes for replay, with the planner running concurrently
with the previous resource's playback. The shape stays the same
whether the producer is music, video, image variants, or LLM tool
output — only the call inside `Stream.unwrap` changes.

Source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/radio-station/index.ts)
and [`run-bun.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/radio-station/run-bun.ts).
