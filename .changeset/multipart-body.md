---
"@effect-uai/core": patch
"@effect-uai/openai": patch
"@effect-uai/elevenlabs": patch
"@effect-uai/mistral": patch
---

Fix multipart uploads hanging forever under `NodeHttpClient.layerUndici`.

`HttpClientRequest.bodyFormData` keeps the `FormData` object, and the Undici
client passes it straight to `dispatcher.request`, which cannot serialise it:
the request is never sent, and the effect waits with no error and no timeout.
The `node:http` and fetch clients encode first, so only Undici was affected,
which made JSON endpoints work while every multipart one on the same provider
hung. This hit OpenAI image edits and transcription, ElevenLabs
speech-to-text, and Mistral transcription.

New `@effect-uai/core/Multipart` exports `bodyMultipart`, which encodes the
form to bytes and sets the boundary content-type, so the request works on
every client. All four call sites use it.
