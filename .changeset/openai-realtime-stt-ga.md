---
"@effect-uai/openai": patch
---

Fix `OpenAIRealtimeTranscriber` for the GA Realtime wire and move off the deprecated transcription models.

The adapter still sent the `OpenAI-Beta: realtime=v1` upgrade header, which OpenAI shut down on 2026-05-12, and the beta `transcription_session.update` frame. The upgrade now carries only `Authorization`, the session is configured with `session.update { type: "transcription", audio.input.{format, transcription, turn_detection} }`, and the server acks are read under their GA names (`session.created` / `session.updated`). Transcript, VAD and error events are unchanged.

`vadEvents` now maps to the GA `audio.input.turn_detection` field and stays on unless you pass `false`. Server VAD is what commits a turn, and only a committed turn yields a `final` transcript, so a session without it emits partials forever. Models that transcribe continuously rather than segmenting reject the field and need `vadEvents: false`.

`OpenAITranscribeModel` gains `gpt-transcribe`, `gpt-live-transcribe` and `gpt-realtime-whisper`. `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` and `whisper-1` stay in the union but are deprecated by OpenAI (shutdown 2027-02-26).

**Migration.** No code changes are required for the wire fix. Swap model ids before the shutdown date: `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` become `gpt-transcribe` for `transcribe` and `gpt-live-transcribe` for `streamTranscriptionFrom`. `whisper-1` remains the only model that returns `wordTimestamps`; there is no replacement for that path yet. The recipes `basic-transcription` and `streaming-transcription` default to the new ids.
