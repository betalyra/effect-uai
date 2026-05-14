---
title: Basic transcription
description: Drop an audio file in, get text back. Same call, swap the provider.
source: recipes/basic-transcription
---

A finished audio file should be easy to treat like text.

This recipe takes a voice note, meeting clip, podcast excerpt, or any
other file you already have, sends it to a transcription provider, and
returns the transcript. The same program can run on OpenAI or Gemini;
the provider choice stays in the runner.

**Scenario.** You have `meeting.mp3` and want the text. If you are on
OpenAI Whisper you can also ask for word timestamps and build a simple
timeline.

## The Shape

One call does the work:

```ts
import { transcribe } from "@effect-uai/core/Transcriber"

const result = yield* transcribe({
  audio: { _tag: "bytes", bytes: audioBytes, mimeType: "audio/mpeg" },
  model: "gpt-4o-transcribe",
  language: "en",
})
// result.text   : string
// result.words? : WordTimestamp[]  (only with wordTimestamps + whisper-1)
```

The important part is the boundary: audio bytes in, typed transcript
data out. `index.ts` only depends on the generic `Transcriber` tag, so
the runner can provide OpenAI or Gemini without changing the recipe
body.

## Fast Text Or Timestamps

The recipe includes two paths:

- **Fast** uses the provider's normal text-only model. It works on both
  OpenAI and Gemini.
- **Verbose** uses OpenAI `whisper-1` with `wordTimestamps: true`, so
  you get `result.words` as well as `result.text`.

Gemini's transcription is prompt-driven and text-only, so the runner
skips the timestamp variant when you choose `--provider gemini`.

| Provider | Fast model | Timestamp path |
| --- | --- | --- |
| `openai` | `gpt-4o-transcribe` | `whisper-1` |
| `gemini` | `gemini-2.5-flash` | not supported |

## Run it

```sh
# Default: OpenAI
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-transcription/run-node.ts path/to/audio.wav

# Gemini
GOOGLE_API_KEY=...   pnpm tsx recipes/basic-transcription/run-node.ts --provider gemini path/to/audio.wav
```

Accepted formats: `m4a`, `mp3`, `mp4`, `mpeg`, `mpga`, `oga`, `ogg`,
`wav`, `webm`, `flac`. Gemini caps total inline request size at 20 MB.

## What This Generalizes To

Use `transcribe` whenever you have the whole audio asset up front:
uploads, async jobs, podcast processing, meeting notes. For a live mic,
switch to [Streaming transcription](/recipes/streaming-transcription/);
the shape is the same service, but the input is a `Stream<Uint8Array>`
and the output is a stream of partial and final transcript events.

The full source lives next to this README at
[`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/basic-transcription/index.ts).
