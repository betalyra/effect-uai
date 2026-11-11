---
title: Basic video generation
description: "Submit a clip, keep the job's ref, watch it settle, stream the video to disk. Gemini Omni or fal behind one `VideoGenerator` service."
source: recipes/basic-video-generation
---

Video generation takes seconds to minutes and costs money per clip, so
it is a background job, not a call you wait on. This recipe does each
step in the open: submit, keep the job's ref, watch it settle, read the
video.

**Scenario.** Generate a short clip from a prompt with Gemini Omni, or
with any fal video endpoint, and save it as MP4. If the run is
interrupted while the clip renders, resume it without paying for a
second one.

## Submit, persist, watch, read

```ts
import * as Job from "@effect-uai/core/Job"
import * as VideoGenerator from "@effect-uai/core/VideoGenerator"

const program = Effect.gen(function* () {
  // 1. Returns as soon as the provider accepts the job. The ref is plain data.
  const ref = yield* VideoGenerator.submit({ model: "gemini-omni-1.2-flash", prompt })

  // 2. Persist it before polling: a crash from here on loses nothing.
  yield* fs.writeFileString("ref.json", yield* Schema.encodeEffect(RefJson)(ref))

  // 3. Poll until the job settles, logging each state. The cadence is yours.
  const { videos } = yield* VideoGenerator.watch(ref, { pollInterval: "5 seconds" }).pipe(
    Stream.tap((state) => Effect.logInfo(`job ${state._tag}`)),
    Job.result(ref),
  )

  // 4. Read the clip through the provider that produced it, straight to disk.
  yield* VideoGenerator.toStream(videos[0]!.video).pipe(Stream.run(fs.sink("clip-0.mp4")))
})
```

`RefJson` is `Schema.fromJsonString(VideoGenerator.VideoJobRef)`, so a
ref read back from disk is typed again without a cast. `Job.result`
returns what the last state carries: the videos, or the job's own error.

A failed poll leaves the job running, so the recipe retries step 3 a few
times; retrying step 1 would pay for a second clip. On resume, the layer
comes from the ref's provider, whatever `--model` says.

The recipe yields the generic `VideoGenerator` service; `--model` picks
the provider's Layer, so the same body runs against both.

`generate(request)` is the one-call version (submit, then collect,
cancelling the job if you interrupt it). The recipe spells the steps out
because the ref is what makes a job survive the process that started it.

## Run it

```sh
# Gemini Omni (default)
GOOGLE_API_KEY=... pnpm tsx recipes/basic-video-generation/run.ts

# fal: the model is the endpoint path
FAL_API_KEY=... pnpm tsx recipes/basic-video-generation/run.ts \
  --model fal:minimax/h3-max-turbo/text-to-video

# Interrupt while it polls (Ctrl-C), then resume the same job
GOOGLE_API_KEY=... pnpm tsx recipes/basic-video-generation/run.ts \
  --ref output/basic-video-generation/<timestamp>/ref.json
```

Ctrl-C while polling does not cancel the job: the recipe uses `watch`,
which leaves it running at the provider, so `--ref` picks up the clip
you already paid for.

| Flag            | Default                 | Notes                                             |
| --------------- | ----------------------- | ------------------------------------------------- |
| `--model`       | `gemini-omni-1.2-flash` | `provider:model`; `fal:<endpoint path>` for fal.  |
| `--prompt-file` | built-in                | Path to a `.txt` file with your prompt.           |
| `--ref`         | none                    | A saved `ref.json`: resume instead of submitting. |
| `--out`         | timestamped             | Output directory.                                 |

Clips land in `output/basic-video-generation/<timestamp>/clip-0.mp4`,
next to `ref.json`.

## What comes back

A finished job's `GeneratedVideo.video` is one of:

- **`url`** (fal and most providers): a link that works for anyone who
  holds it until it expires, an hour to thirty days depending on the
  provider. Treat it like a short-lived secret, and copy anything you
  want to keep into your own storage.
- **`ref`** (Gemini Omni by default): a file the provider holds, readable
  only through that provider. `toStream` sends Omni's key with it; a
  plain GET would be refused.
- **`base64`**: inline delivery (Omni with `delivery: "inline"`, fal's
  `sync_mode`), already in memory.

`toStream` handles all three, so the recipe never looks at which one it
got.
