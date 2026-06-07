---
"effect-uai": minor
"@effect-uai/core": minor
"@effect-uai/responses": minor
"@effect-uai/anthropic": minor
"@effect-uai/google": minor
"@effect-uai/jina": minor
"@effect-uai/openai": minor
"@effect-uai/elevenlabs": minor
"@effect-uai/inworld": minor
"@effect-uai/microsandbox": minor
"@effect-uai/deno": minor
---

0.7 is a capability-honesty pass across every audio and embedding
surface. The unifying rule: where a provider cannot honor a request, the
call now fails with `AiError.Unsupported` (load-bearing gaps) or emits a
structured `warnDropped` (best-effort hints), instead of silently
substituting a different result. Alongside that, `Duration` replaces raw
`durationSeconds` everywhere audio carries a length, the `MusicGenerator`
surface is reshaped, an ElevenLabs music provider lands, and Gemini
`toolChoice` is now mapped.

Most of it is mechanical (find-and-replace renames plus a
`Duration.seconds(n)` wrap). The parts that need judgement are the
removed `GeminiTranscriber` (use OpenAI / ElevenLabs / Inworld instead)
and the requests that now error where they previously degraded silently.
The full before/after diffs and the recommended order live in
[Migrating to 0.7](https://effect-uai.betalyra.com/migrations/v0-7/).

`@effect-uai/anthropic`, `@effect-uai/microsandbox`, and
`@effect-uai/deno` have no functional changes this release; they bump for
lockstep versioning only.
