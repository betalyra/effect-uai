---
title: Speech
description: Transcription and synthesis — text crossing the audio boundary in either direction.
---

Voice notes, captions, and read-aloud answers all need the same thing:
a model that crosses the audio boundary.

Speech-to-text turns recorded or live audio into text. Text-to-speech
turns text into recorded or live audio. They're paired in workflows —
a voice agent transcribes the user, runs a turn, and synthesises the
answer — so they live in the same section.

Both archetypes are simple: one-shot for finished audio, streaming
delta for live capture or playback. No tool loop, no duplex. (For
duplex voice agents see [realtime audio](/realtime-audio/).)

## Coming soon

`@effect-uai/core` will ship `Transcriber` and `SpeechSynthesizer`
service tags. Provider candidates:

- **OpenAI** — `whisper-1` and `gpt-4o-transcribe` for STT;
  `tts-1`, `tts-1-hd`, and `gpt-4o-mini-tts` for TTS.
- **ElevenLabs** — TTS-focused, voice cloning, streaming
  `eleven_turbo_v2`.
- **Deepgram** — low-latency streaming STT (`nova-3`).
- **Google** — Gemini live audio + Cloud Speech.

Voice cloning fits as a request flag inside `SpeechSynthesizer` rather
than its own capability — the workflow shape is identical, just with a
reference-audio input.

## Show interest

Open or +1 the
[speech tracking issue](https://github.com/betalyra/effect-uai/issues/new?title=Capability%3A+Speech+%28STT+%2F+TTS%29&body=I%27m+interested+in+speech+support.+STT%2C+TTS%2C+or+both%3A+%0AProvider%28s%29%3A+%0A%0AUse+case%3A+)
to tell us what you need and which provider.
