---
"@effect-uai/core": minor
---

Add the `RealtimeSession` capability: types, service tag, video marker and a scripted mock. Two adapters ship alongside it, `@effect-uai/openai/OpenAIRealtimeSession` and `@effect-uai/google/GeminiLiveSession`.

A realtime session is one long-lived duplex connection the server drives, which is why it is its own primitive rather than a mode of `Loop`. `RealtimeSession.open(request)` returns `{ send, events }` scoped to the connection; closing the scope closes the socket.

- `@effect-uai/core/Realtime` holds `RealtimeInput` (audio, text, tool result, interrupt, video frame, activity boundaries, playback position), `RealtimeEvent` (response boundaries, audio and transcript deltas, input transcripts, speech boundaries, tool calls and cancellations, interruptions, resumption handles, session end, non-fatal errors) and `CommonSessionRequest`. Both unions carry only what OpenAI Realtime and Gemini Live do natively; VAD knobs, truncation, thinking, grounding and noise reduction stay provider-typed.
- `@effect-uai/core/RealtimeSession` holds the `RealtimeSession` tag, the `RealtimeVideoInput` capability marker, the `open` helper, `sendVideoFrame` (which requires the marker, so video against an audio-only provider is a compile error) and the `audioDeltas` / `toolCalls` filters.
- `@effect-uai/core/testing/MockRealtimeSession` scripts a session from an opening event list and a function from each input to its answer, recording every `send`. `layer` ships the video marker, `layerAudioOnly` does not.
- `AiError` gains `SessionExpired { provider, raw? }` for a session that hit the provider's lifetime cap, where reconnecting works but retrying does not.

Tool execution, playback, barge-in bookkeeping and reconnection are deliberately left to the caller. There is no agent wrapper, no hidden queue and no automatic reconnect.
