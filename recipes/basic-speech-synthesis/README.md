---
title: Basic speech synthesis
description: "Synthesize a phrase with OpenAI TTS: one-shot `synthesize` returning a full AudioBlob, and chunked `streamSynthesis` returning a Stream of AudioChunks."
---

Synthesize a short phrase with OpenAI's text-to-speech models.

Two paths are shown:

- `synthesizeOneShot` — `SpeechSynthesizer.synthesize`: text in, full `AudioBlob` (with format + bytes) out in one go.
- `synthesizeStreaming` — `SpeechSynthesizer.streamSynthesis`: text in, audio arrives as a `Stream<AudioChunk>`. The recipe collects + concatenates for demo purposes; in real use pipe the stream directly to a speaker, file write, or WebSocket.

`streamSynthesisFrom` (incremental text-in over WebSocket) is **not** demonstrated here because OpenAI does not offer that endpoint — see `plans/stt-tts.md`. The `@effect-uai/openai-speech` Layer omits the `TtsIncrementalText` capability marker, so attempting to call `streamSynthesisFrom` against it is a compile-time error.

## Run

```sh
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-speech-synthesis/run-node.ts
```

Writes `out-oneshot.mp3` and `out-streaming.mp3` next to the recipe.
