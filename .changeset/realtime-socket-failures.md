---
"@effect-uai/openai": minor
"@effect-uai/elevenlabs": minor
"@effect-uai/inworld": minor
"@effect-uai/mistral": minor
---

Realtime transcription and synthesis streams now fail when they should, instead of ending as if they had finished.

- A dropped connection (any close other than 1000, 1001 or 1005) fails the stream with `AiError`. Before, the transcript or audio simply ended, so a caller could not tell a finished stream from a broken one, and retry or fallback never ran.
- An error in the input stream (the audio for transcription, the text for synthesis) fails the output stream with that error. Before, it was swallowed and the session ran on until the server closed it.

Both match the declared `AiError | E` error type. A clean server close still ends the stream normally.

`MistralRealtimeTranscriber`'s config gains an optional `webSocket` to build the socket yourself, for a proxy or an in-memory transport. The default still attaches the bearer token through the `ws` package.
