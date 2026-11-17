---
title: Radio station
description: Run your own AI radio station. An AI DJ writes each track one ahead of what you are listening to; the station runs on the server, so a reload picks up where you were.
source: recipes/radio-station
icon: PiRadio
---

An AI radio station is a DJ that writes each track just before it plays.

You give it a one-line brief (say `"late-night lo-fi study session"`)
and the DJ writes the first track. While you listen to it, the DJ is
already writing and generating the next one. After 10 tracks the set
loops; from then on it replays straight from disk, free.

**Scenario.** Open the page, click **Start**, listen. The first track
plays once it has been generated; after that, the next one is ready
before the current one ends. Reload the page and press **Listen**: you
are back at the track you were on, and nothing is generated twice.

## The shape

The station runs on the server, started once by the first **Start**.
What a listener needs to know is a session stream of `@effect-uai/ui`
entries, typed by a contract both sides import (`contract.ts`):

| Entry                         | What it holds                                     |
| ----------------------------- | ------------------------------------------------- |
| `data "station"`              | the brief and the length of the set               |
| `data "track"` (one per slot) | its title, `generating` then `ready`, in place    |
| `media "track-N"`             | a finished track, as a URL this server serves     |
| `live "listening"`            | the track a listener reached, so a reload resumes |
| `live "problem"`              | why the station stopped, if it did                |

The browser folds that stream with `StreamView` and plays the finished
tracks in order with one `<audio>`. It reports each track it starts
(`POST /listening`), and that report is what paces generation.

```
  brief ─▶ plan track N ─▶ generate to disk ─▶ data "track" ready + media
              ▲                                             │
              └── waits until the listener reached N-1 ◀────┘ POST /listening
```

## One track ahead

`runStation` is a stream that makes track `N` only once the listener is
on track `N-1`. The listener's position is a `SubscriptionRef`, so
waiting for it is a stream filter:

```ts
const reached = (listening, index) =>
  SubscriptionRef.changes(listening).pipe(
    Stream.filter((at) => at >= index),
    Stream.runHead,
  )

const tracks = (cfg, index, plans) =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* reached(cfg.listening, index - 1)
      const plan = yield* planTrack(cfg.brief, index, cfg.trackCount, plans, cfg.plannerModel)
      return entry(index, plan, "generating").pipe(
        Stream.concat(Stream.drain(Stream.fromEffect(generateTrack(plan, index, ...)))),
        Stream.concat(entry(index, plan, "ready")),
        Stream.concat(Stream.succeed(trackMedia(index, plan))),
        Stream.concat(tracks(cfg, index + 1, [...plans, plan])),
      )
    }),
  )
```

Closing the tab stops nothing, but a station nobody listens to stops
paying after the next track.

## The cache

`generateTrack` writes the generation into a `.partial` file as chunks
arrive, renamed on success and removed on failure or interrupt, so a
half-written track is never taken for a cached one. A track already on
disk is not generated again.

## The host

`app.ts` runs the station in a fiber scoped to the server and publishes
its events into a `PubSub` that replays from the start (the shape of the
[durable chat](/recipes/durable-chat/) recipe). Every page follows the
same stream from `GET /events`, so a reload gets the whole set and then
the live updates.

## Run it

```sh
OPENAI_API_KEY=...     # planner (Responses)
ELEVENLABS_API_KEY=... # music (ElevenLabs Music), default
GOOGLE_API_KEY=...     # music (Google Lyria), alternative

pnpm tsx recipes/radio-station/run.ts

# Pick a music provider:
pnpm tsx recipes/radio-station/run.ts --music-model=google:lyria-3-clip-preview

# Custom brief, custom track count:
pnpm tsx recipes/radio-station/run.ts \
  --brief "synthwave roadtrip, neon and fast" --tracks 8
```

Open `http://localhost:3000` and click **Start**. Tracks land in
`output/radio-station/cache/{provider}/`. Delete the folder to force
fresh generation; tracks are reused across runs.

## Cost shape

- **First pass**: one small planner call and one music generation per
  track, at most one track ahead of the listener.
- **Later passes**: zero. The audio files are on disk.

Source: [`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/radio-station/recipe.ts).
