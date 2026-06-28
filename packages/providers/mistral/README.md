# @effect-uai/mistral

Mistral provider for [`@effect-uai/core`](https://www.npmjs.com/package/@effect-uai/core).

One package, the whole Mistral surface:

- **`Mistral`** — the `LanguageModel` contract against Mistral's
  chat-completions API, with SSE streaming, function calling, and
  `json_schema` structured output.
- **`MistralTranscriber`** — batch speech-to-text (Voxtral) via
  `/v1/audio/transcriptions`.
- **`MistralRealtimeTranscriber`** — live speech-to-text over the
  Voxtral Realtime WebSocket (registers the `SttStreaming` capability).
- **`MistralSynthesizer`** — Voxtral text-to-speech, including streaming
  output and zero-shot voice cloning via a reference clip.

## Install

```sh
pnpm add @effect-uai/mistral @effect-uai/core effect
```

ESM-only. Requires `effect@4.x` and `@effect-uai/core` as peers. The
realtime transcriber additionally needs the optional `ws` peer (Node /
Bun only).

## Usage

### Chat completions (LanguageModel)

```ts
import { Config, Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { layer as mistralLayer } from "@effect-uai/mistral/Mistral"

const provider = Layer.unwrap(
  Effect.gen(function* () {
    const apiKey = yield* Config.redacted("MISTRAL_API_KEY")
    return mistralLayer({ apiKey })
  }),
)

const layer = Layer.provide(provider, FetchHttpClient.layer)
```

The layer registers both the provider-typed `Mistral` tag and the
generic `LanguageModel` tag.

### Voxtral speech (STT + TTS)

```ts
import { layer as transcriber } from "@effect-uai/mistral/MistralRealtimeTranscriber"
import { layer as synthesizer } from "@effect-uai/mistral/MistralSynthesizer"

// transcriber({ apiKey }) registers Transcriber + SttStreaming
// synthesizer({ apiKey }) registers SpeechSynthesizer + TtsIncrementalText
```

For batch (non-streaming) transcription, import
`@effect-uai/mistral/MistralTranscriber` instead — it omits the `ws`
dependency.

## Notes

- `tool_choice` maps `"required"` to Mistral's `"any"`.
- Voxtral TTS `pcm` output is float32 LE; `wav` is s16le.
- The realtime STT wire frames are reconstructed from the SDK; verify
  against the live API before production use.

## Docs

<https://effect-uai.betalyra.com/providers/mistral/>

## License

MIT
