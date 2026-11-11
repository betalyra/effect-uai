---
title: Video generation
description: "Prompt to clip as an explicit background job: submit, keep the ref, watch it settle, read the video. Portable across providers."
---

A clip takes seconds to minutes to render and costs money per call.
That changes the shape of the abstraction: a call that sits on a
connection for five minutes is a timeout waiting to happen, and a crash
halfway through pays for a clip nobody can find again.

So `VideoGenerator` is a **background job you drive yourself**. Every
provider works this way on the wire: submit, get an id, poll.

```ts
import { Effect } from "effect"
import * as VideoGenerator from "@effect-uai/core/VideoGenerator"

const program = Effect.gen(function* () {
  const { videos } = yield* VideoGenerator.generate({
    model: "gemini-omni-1.2-flash",
    prompt: "A red fox trotting through fresh snow at golden hour",
  })
  return videos
})
```

`generate` is the one-liner: submit, poll until done, cancel the job if
you interrupt it. Everything it does is also available step by step.

## Four calls, and the loops are yours

The service is four wire calls:

- **`submit`**: start a generation; returns a `VideoJobRef` as soon as
  the provider accepts it.
- **`status`**: one poll.
- **`cancel`**: stop the job at the provider.
- **`read`**: stream a video the provider produced.

The loops are accessors over the tag, and their cadence and timeout are
arguments, never hidden defaults:

- **`watch(ref)`**: every polled state as a `Stream`, ending at the
  settled one. Queue position for a progress line comes for free.
- **`collect(ref)`**: poll until settled, return the videos.
- **`generate(request)`**: `submit` then `collect`, cancelling on
  interrupt.

## Keep the ref, survive the crash

A `VideoJobRef` is plain data: `{ _tag: "JobRef", provider, id }`. Write
it down before you poll, and a restarted process collects the job
already running at the provider instead of paying for a second clip.

```ts
const RefJson = Schema.fromJsonString(VideoGenerator.VideoJobRef)

const start = Effect.gen(function* () {
  const ref = yield* VideoGenerator.submit({ model, prompt })
  yield* fs.writeFileString("ref.json", yield* Schema.encodeEffect(RefJson)(ref))
})

// later, possibly in another process
const finish = Effect.gen(function* () {
  const saved = yield* Schema.decodeEffect(RefJson)(yield* fs.readFileString("ref.json"))
  const { videos } = yield* VideoGenerator.collect(saved, { pollInterval: "5 seconds" })
  return videos
})
```

The schema gives the ref back its type, so a persisted ref needs no
cast. Interrupting `collect` or `watch` leaves the job running, which is
what makes this work; `generate` is the one that cancels, on any exit
but success, its own timeout included.

The same property makes `collect` the place to retry. A failed poll (a
dropped connection, a 503) ends `collect` but not the job, so running it
again picks up where it was. Retrying `generate` submits again and pays
for a second clip.

```ts
VideoGenerator.collect(saved).pipe(Retry.effect(Schedule.exponential("2 seconds")))
```

A ref names the provider that minted it. Handing it to another
provider's service fails `InvalidRequest` before anything is sent.

## Reading the video

A finished job's `video` is a `VideoSource`, and what kind depends on
the provider:

- **`url`**: a link anyone holding it can fetch until it expires, an
  hour to thirty days. Treat it like a short-lived secret, and copy
  anything private or long-lived into your own storage.
- **`ref`**: `{ provider, id }`, a file the provider holds and only that
  provider can read, because reading it needs the provider's key.
- **`base64`**: inline delivery, already in memory.

You never branch on which one you got. Read through the provider:

```ts
const save = VideoGenerator.toStream(video).pipe(Stream.run(fs.sink("clip.mp4")))
const inMemory = VideoGenerator.toBytes(video) // Uint8Array; the type is `video.mimeType`
```

`toStream` streams a URL without holding the clip in memory, sends the
key only for the provider's own refs, and decodes inline data. Nothing
is fetched until you run it, so passing a `url` straight to a browser
costs nothing.

## Frames and references

```ts
import { VideoInput } from "@effect-uai/core/Video"

VideoGenerator.submit({
  model,
  prompt: "The fox leaps into a snowbank",
  inputs: [VideoInput.FirstFrame({ image: still })],
  duration: Duration.seconds(6),
  aspectRatio: "16:9",
  resolution: "720p",
})
```

`inputs` is ordered, and every item names its role, because the role is
not inferable: the same image means a different clip as a first frame,
a last frame or a style reference. `FirstFrame`, `LastFrame`,
`ReferenceImage` and `ReferenceVideo` are the roles. A `ref` from the
same provider can go back in as a `ReferenceVideo` without a download.

A role or combination a provider cannot honor fails `Unsupported`
before the request goes out; a knob it has no field for (a seed, say)
is dropped with a warning. Audio is not on the portable request:
providers disagree too much on whether and how it can be asked for.

## When something goes wrong

| Situation                                    | Error                                      |
| -------------------------------------------- | ------------------------------------------ |
| The provider failed the job                  | `GenerationFailed`, with its reason        |
| The provider refused the prompt              | `ContentFiltered`, where it says so        |
| The job never settled within `timeout`       | `Timeout`                                  |
| A role, ratio or tier the provider cannot do | `Unsupported`, before the request goes out |
| Another provider's job ref                   | `InvalidRequest`, before the request       |
| Reading an expired or revoked link           | `InvalidRequest`, naming the provider      |
| A download that breaks off                   | `Unavailable`, safe to retry               |
| Reading another provider's `ref`             | `Unsupported`                              |

## Providers

- [Google](/video-generation/providers/google/): Gemini Omni 1.2. Clips
  up to 15 s, frames and references, file refs by default.
- [Fal](/video-generation/providers/fal/): MiniMax H3, Seedance, Veo,
  Kling, LTX and the rest of Fal's video catalogue behind one key.
