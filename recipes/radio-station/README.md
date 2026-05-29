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

`runStation` is a single `Stream<ServerEvent>` that interleaves
control events (`track-start`, `track-end`, `track-planned`) with raw
audio chunks (a `{ type: "data", bytes }` variant). One prefetch fiber
always runs for the next track, so by the time the current one ends
the next is on disk.

```
                            [brief]
                               │
                               ▼  plan track 0
                         { title, prompt }
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│  prefetch fiber : plan track N+1 → gen track N+1 → disk      │
│  main loop      : emit events + audio as ServerEvent         │
└─────────────────────────────────────────────────────────────┘
                               │
                               ▼  Stream<ServerEvent>
```

## End-to-end streaming

`trackStream(plan, i)` returns a `Stream<Uint8Array>`. It never drains
itself. Cache policy lives inside: hit the file if it's already on
disk, otherwise generate and tee chunks into a `.partial` file that
gets renamed on success or removed on failure.

```ts
const trackStream = (plan, i) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const file = `tracks/track-${i}.mp3`

      if (yield* fs.exists(file).pipe(Effect.orDie)) {
        return fs.stream(file).pipe(Stream.orDie)
      }

      const partial = `${file}.partial`
      const handle = yield* fs.open(partial, { flag: "w" }).pipe(Effect.orDie)
      yield* Effect.addFinalizer((exit) =>
        Exit.isSuccess(exit)
          ? fs.rename(partial, file).pipe(Effect.orDie)
          : fs.remove(partial, { force: true }).pipe(Effect.ignore),
      )

      return MusicGenerator.streamGeneration({ ... }).pipe(
        Stream.map((c) => c.bytes),
        Stream.tap((bytes) => handle.writeAll(bytes).pipe(Effect.orDie)),
      )
    }),
  )
```

The same producer feeds both the main loop (which forwards bytes
downstream as `{ type: "data", bytes }`) and the prefetcher (which
just drains it — the cache file is the side-effect that matters).

## The loop

The radio runs through the `loop` primitive. State (`cycle`, `idx`,
the current prefetch fiber, the plans seen so far) threads through
`next(...)`; the body emits a stream of events for one track and ends
with the new state.

```ts
const body = (state: LoopState) =>
  Stream.unwrap(
    Effect.gen(function* () {
      // 1. Wait for THIS track's prefetch (gen + maybe a fresh plan).
      const { newPlan } = yield* Option.match(state.prefetch, {
        onNone: () => Effect.succeed({ newPlan: Option.none<TrackPlan>() }),
        onSome: Fiber.join,
      })
      const plans = Option.match(newPlan, {
        onNone: () => state.plans,
        onSome: (p) => [...state.plans, p],
      })

      // 2. Kick prefetch for the NEXT track. Plan in cycle 0; cached
      //    plan in cycle 1+.
      const nextIdx = (state.idx + 1) % cfg.trackCount
      const fiber = yield* Effect.forkChild(prefetch(cfg, nextIdx, plans))

      // 3. Emit: optional track-planned (when the just-joined fiber
      //    returned a fresh plan), track-start, audio chunks,
      //    track-end, await ack, then advance state.
      const currentPlan = plans[state.idx]!
      return Stream.fromIterable(upfrontEvents).pipe(
        Stream.map(v),
        Stream.concat(
          trackStream(currentPlan, state.idx, ...).pipe(
            Stream.map((bytes) => v({ type: "data", bytes })),
          ),
        ),
        Stream.concat(Stream.succeed(v({ type: "track-end", index: state.idx }))),
        Stream.concat(Stream.fromEffect(cfg.waitTrackEnded).pipe(Stream.drain)),
        Stream.concat(next<LoopState>({ ...nextState })),
      )
    }),
  )
```

`waitTrackEnded` is the recipe's only external input: an `Effect<void>`
that resolves when the consumer signals the track finished playing.
That's the backpressure — generation runs at most one track ahead of
actual listening.

## Run it

```sh
OPENAI_API_KEY=...     # planner (Responses)
ELEVENLABS_API_KEY=... # music (ElevenLabs Music) — default
GOOGLE_API_KEY=...     # music (Google Lyria) — alternative

bun recipes/radio-station/run-bun.ts

# Pick a provider; switch via argv:
bun recipes/radio-station/run-bun.ts --provider=google

# Custom brief, custom track count:
STATION_BRIEF="synthwave roadtrip, neon and fast" \
TRACK_COUNT=8 \
  bun recipes/radio-station/run-bun.ts
```

Open `http://localhost:3000`, click **Start**. Tracks land in
`recipes/radio-station/tracks/{provider}/`. Delete the folder to
force fresh generation with a new plan; tracks are reused across runs.

There are equivalent `run-node.ts` and `run-deno.ts` runners next to
`run-bun.ts` — same recipe body, swapped platform layers.

## Cost shape

- **Cycle 0**: N+1 small planner calls (one upfront + one per
  prefetched track) + N music generations.
- **Cycle 1+**: zero. The plan list and the audio files are both
  cached.
- **Pipeline depth**: max 2 generations in flight at any time (one
  playing, one prefetching). Bounded by `Fiber.join` at the top of
  each loop iteration.

## What this generalises to

The Stream-as-output / cache-tee / next-fiber pattern is the shape
any time you want to stream a generated resource to a live consumer
while caching the bytes for replay, with the planner running
concurrently with the previous resource's playback. Substitute music
for video, image variants, or LLM tool output — only the call inside
`Stream.unwrap` changes.

Source: [`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/radio-station/recipe.ts).
