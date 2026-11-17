---
title: TV station
description: An AI invents a TV channel and plans its running order; each slot becomes a generated video clip, aired as one live broadcast with render progress in the browser.
source: recipes-extras/tv-station
icon: PiTelevision
---

An LLM invents a channel nobody has made before, plans its running order a
few segments at a time, and each segment becomes a short clip through the
generic `VideoGenerator`. The clips play as one continuous broadcast; a
standby card covers the wait whenever the next clip is still rendering.

An extras recipe because it encodes video with FFmpeg (`node-av`, prebuilt
bindings) and assembles MP4 with `mediabunny`.

## Run it

```sh
pnpm -C recipes-extras/tv-station install

OPENAI_API_KEY=... FAL_API_KEY=... \
  ./recipes-extras/tv-station/node_modules/.bin/tsx recipes-extras/tv-station/run.ts --budget 12
```

Open `http://localhost:3000` and press **Play**. Nothing is planned or
generated before that.

| Flag                       | What it does                                                                  |
| -------------------------- | ----------------------------------------------------------------------------- |
| `--budget 30` / `--clip 6` | seconds of video to generate, and per clip: `--budget 12` is two clips        |
| `--brief` / `--brief-file` | what the channel should be about                                              |
| `--search`                 | research the brief on the web first (`--search-provider exa` or `tavily`)     |
| `--video-model`            | `fal:<endpoint>` (default MiniMax H3 turbo) or `google:gemini-omni-1.2-flash` |
| `--loop` / `--infinite`    | replay the running order (default on) / ignore the budget                     |
| `--dry-run`                | plan the channel and the first clips, generate nothing                        |
| `--rehearse`               | replay the clips already on disk, generate nothing                            |
| `--fresh`                  | start a new station beside the last one instead of resuming it                |

## How it works

- **The station runs on the server**, started by the first Play. Closing the
  tab stops nothing and every tab sees the same channel; stop the server to
  end it.
- **What a viewer is told** is a session stream of `@effect-uai/ui` entries,
  typed by `contract.ts`: the channel, one `clip` entry per slot carrying its
  render job's state (queued, rendering, done), each finished clip as
  `media`, and what is on screen as `live`. The page folds it with
  `StreamView`. See [Program streams](https://effect-uai.com/agentic-ui/program-streams/).
- **The picture** is one fragmented MP4 on `GET /stream`, paced against the
  wall clock. `GET /programme.mp4` joins every clip so far into one file.
- **Nothing is paid for twice.** `station.json` records each clip's job ref
  before polling starts, so a restart collects a clip that is still
  rendering instead of submitting it again. Clips are cached under
  `output/tv-station/cache/<provider>/`.
