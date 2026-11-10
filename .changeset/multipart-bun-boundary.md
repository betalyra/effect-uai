---
"@effect-uai/core": patch
---

`bodyMultipart` keeps the multipart boundary on Bun. It read the encoded body's `content-type` after consuming the body, and Bun answers `null` for that header once the body is read, so the request went out as a bare `multipart/form-data` and the server could not parse it: every OpenAI transcription and image edit failed with "Could not parse multipart form". The header is now read first.
