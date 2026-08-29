# @effect-uai/mistral

## 0.13.0

### Patch Changes

- @effect-uai/chat-completions@0.13.0

## 0.12.1

### Patch Changes

- @effect-uai/chat-completions@0.12.1

## 0.12.0

### Patch Changes

- a739370: Rebuild the Mistral language model on `@effect-uai/chat-completions`. Mistral
  speaks the OpenAI chat-completions dialect, so it now shares the streaming
  decoder and tool encoding with the generic base, keeping only its wire quirks
  local (bare-string `image_url`, `tool_choice: "any"`, and the `model_length`
  finish reason). No public API change; `@effect-uai/chat-completions` becomes a
  dependency.
- a739370: Fix synthesized tool-call ids failing Mistral's `^[a-zA-Z0-9]{9}$` validation.
  When a streaming tool-call chunk omits its id, the fallback is now a 9-char
  zero-padded index instead of `call_<index>`, which Mistral rejected with a 422
  once the id was replayed on the next turn.
  - @effect-uai/chat-completions@0.12.0

## 0.11.0

### Patch Changes

- 1efb6b4: Bug fixes.
  - **`Toolkit.namespace`** now preserves a tool's typed error `E` and requirement
    `R` through the prefixing rewrite (they were previously widened).
  - **SSE and JSONL decoders** (`@effect-uai/core/SSE`, `@effect-uai/core/JSONL`)
    are now backed by Effect's `unstable/encoding` primitives, for spec-correct
    framing across chunk boundaries.
  - **`Items.UrlCitation`** widens to the provider-agnostic citation shape:
    `start_index` / `end_index` become optional and `cited_text` / `marker` are
    added, so a provider populates whichever anchor it has (offset span, exact
    quote, or positional `[n]` marker) and a bare source list sets none.
  - **Mistral** no longer synthesizes a `TurnComplete` for a truncated or failed
    stream, so a halted turn surfaces as a failure instead of a bogus completion.

## 0.10.0

## 0.9.0

### Minor Changes

- a56e470: New provider `@effect-uai/mistral` (additive). One brand covering three
  capability surfaces:
  - **Language model**: Mistral chat models behind the generic `LanguageModel`
    tag.
  - **Speech to text**: Voxtral batch and realtime (streaming) transcription
    behind `Transcriber`.
  - **Text to speech**: Voxtral synthesis behind `SpeechSynthesizer`.

  Provide `mistral({ apiKey })` and your capability-tag code resolves, unchanged.
  Because all three surfaces share one brand, an entire STT to LLM to TTS
  pipeline can run on Mistral alone (the [Voice loop](https://effect-uai.betalyra.com/recipes/voice-loop/)
  recipe selects it with `--provider=mistral`).

  See [Migrating to 0.9](https://effect-uai.betalyra.com/migrations/v0-9/).
