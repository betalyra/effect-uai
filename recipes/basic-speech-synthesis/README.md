---
title: Basic speech synthesis
description: "Synthesize a phrase via the generic SpeechSynthesizer service. Switch providers with `--provider openai|gemini`, switch modes with `--mode one-shot|streaming|both`."
---

Synthesize a short phrase via the generic `SpeechSynthesizer` service. Provider is picked at the runner level via `--provider`; the recipe Effects (`index.ts`) are provider-agnostic.

Two synthesis paths are shown:

- One-shot — `SpeechSynthesizer.synthesize`: text in, full `AudioBlob` (format + bytes) out in one go.
- Chunked streaming — `SpeechSynthesizer.streamSynthesis`: text in, audio arrives as a `Stream<AudioChunk>`. The recipe collects + concatenates for demo purposes; in real use pipe the stream directly to a speaker, file write, or WebSocket.

`streamSynthesisFrom` (incremental text-in) is **not** demonstrated here because neither provider exposes it sync (OpenAI Realtime WS lands separately; Gemini TTS is sync-only). Both provider Layers omit the `TtsIncrementalText` capability marker, so calling `streamSynthesisFrom` against either is a compile-time error.

## Providers

| Provider           | Model                          | Voice   | Output format                                     |
| ------------------ | ------------------------------ | ------- | ------------------------------------------------- |
| `openai` (default) | `gpt-4o-mini-tts`              | `alloy` | mp3                                               |
| `gemini`           | `gemini-2.5-flash-preview-tts` | `Kore`  | wav (PCM wrapped with RIFF header by the adapter) |

To add a new provider, extend the `Provider` union in [`index.ts`](./index.ts) and add a `Match.when` case in `requestFor` / `outputExtFor` (recipe side) and `layerFor` (runner side). `Match.exhaustive` will fail typecheck until both are updated.

## Run

```sh
# Defaults: --provider openai --mode one-shot
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-speech-synthesis/run-node.ts

# Streaming only
OPENAI_API_KEY=sk-... pnpm tsx recipes/basic-speech-synthesis/run-node.ts --mode streaming

# Both modes, Gemini provider
GOOGLE_API_KEY=...   pnpm tsx recipes/basic-speech-synthesis/run-node.ts --provider gemini --mode both
```

Writes `out-oneshot.<ext>` and/or `out-streaming.<ext>` next to the recipe, where `<ext>` matches the provider's native output format.
