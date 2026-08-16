# Changelog

`effect-uai` is a multi-package repository. Each package keeps its own
changelog:

- [`@effect-uai/core`](packages/core/CHANGELOG.md) — primitives: turns, items, loops, tools, structured output, `LanguageModel`, `EmbeddingModel`, `Transcriber`, `SpeechSynthesizer`, `MusicGenerator` contracts, vector math, audio / image / music domains.
- [`@effect-uai/responses`](packages/providers/responses/CHANGELOG.md) — OpenAI Responses (language) + OpenAIEmbedding provider layers.
- [`@effect-uai/chat-completions`](packages/providers/chat-completions/CHANGELOG.md) — reusable OpenAI Chat Completions `LanguageModel` base, pointable at any compatible gateway (OpenRouter, Requesty, Groq, Together, self-hosted).
- [`@effect-uai/openai`](packages/providers/openai/CHANGELOG.md) — OpenAI stack: Responses language models, embeddings, deep research (re-exported from `@effect-uai/responses`), and speech (sync TTS / STT and Realtime transcription).
- [`@effect-uai/anthropic`](packages/providers/anthropic/CHANGELOG.md) — Anthropic provider layer.
- [`@effect-uai/google`](packages/providers/google/CHANGELOG.md) — Google Gemini (language) + GeminiEmbedding + Gemini speech + Lyria music provider layers.
- [`@effect-uai/elevenlabs`](packages/providers/elevenlabs/CHANGELOG.md) — ElevenLabs speech provider: TTS (incremental text-in) and Scribe v2 Realtime STT.
- [`@effect-uai/inworld`](packages/providers/inworld/CHANGELOG.md) — Inworld speech provider: sync + realtime TTS / STT.
- [`@effect-uai/jina`](packages/providers/jina/CHANGELOG.md) — Jina embedding provider (text + image, sparse, multivector, binary).
