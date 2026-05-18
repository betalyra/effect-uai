---
title: Advanced speech synthesis
description: Multi-speaker dialogue with per-voice pronunciation hints, via the generic SpeechSynthesizer.
source: recipes/advanced-speech-synthesis
---

Two TTS features that don't fit on the `text + voiceId` shape:

- **Dialogue** — multiple voices in one audio file. The model receives
  every turn up front and renders a single mixed result.
- **Pronunciation overrides** — IPA hints that adapters apply when
  they can. Useful for brand names, technical terms, and regional
  pronunciation differences.

The recipe demonstrates both together: a five-turn dialogue comparing
American and British English pronunciations of two words. The spelling
of each turn guides the engine to the right syllables, and the
`pronunciations` map carries IPA hints keyed on each turn's spelling
variant.

## The dialogue

```ts
import { synthesizeDialogue } from "@effect-uai/core/SpeechSynthesizer"

yield* synthesizeDialogue({
  model: "eleven_v3",
  turns: [
    { voiceId: "JBFqnCBsd6RMkjVDRZzb", text: "In American English, it's to-MAY-to." },
    { voiceId: "EXAVITQu4vr4xnSDxMaL", text: "In British English, it's to-MAH-to." },
    { voiceId: "JBFqnCBsd6RMkjVDRZzb", text: "And we say po-TAY-to." },
    { voiceId: "EXAVITQu4vr4xnSDxMaL", text: "Whereas we say po-TAH-to." },
    { voiceId: "JBFqnCBsd6RMkjVDRZzb", text: "Same spelling, different worlds." },
  ],
  pronunciations: [
    { phrase: "to-MAY-to", pronunciation: "təˈmeɪtoʊ", encoding: "ipa" },
    { phrase: "to-MAH-to", pronunciation: "təˈmɑːtoʊ", encoding: "ipa" },
    { phrase: "po-TAY-to", pronunciation: "pəˈteɪtoʊ", encoding: "ipa" },
    { phrase: "po-TAH-to", pronunciation: "pəˈtɑːtoʊ", encoding: "ipa" },
  ],
  outputFormat: { container: "mp3", encoding: "mp3", sampleRate: 44100, bitRate: 128 },
})
```

`synthesizeDialogue` requires the `MultiSpeakerTts` capability marker
in `R`. Provider Layers ship the marker only if they wire the
operation to a native multi-speaker endpoint. Trying to use it against
a Layer that doesn't is a **compile-time error**, not a runtime one —
same pattern as `streamSynthesisFrom` + `TtsIncrementalText`.

The streaming variant `streamSynthesizeDialogue` returns a
`Stream<AudioChunk>` for chunked-HTTP delivery.

## Per-turn pronunciation, with one global map

The `pronunciations` field applies across the request — every
occurrence of a phrase gets the same hint. To get different
pronunciations per voice, key each entry on the spelling variant that
turn uses (`to-MAY-to` in voice A's line, `to-MAH-to` in voice B's).

The hyphenated spelling is also useful insurance: even when the
engine silently drops the phoneme tags (i.e. ElevenLabs `eleven_v3`,
which doesn't honor `<phoneme>` tags), the syllable hint in the
spelling itself nudges pronunciation in the right direction.

## Per-provider behavior

| Provider | `synthesizeDialogue` | Pronunciations |
|---|---|---|
| **ElevenLabs** | Wired: `POST /v1/text-to-dialogue` (sync) + `/stream` (chunked). Ships `MultiSpeakerTts`. | Inline SSML `<phoneme>` for the gated models `eleven_flash_v2`, `eleven_english_v1`, `eleven_monolingual_v1`. Other models silently drop. `x-sampa` is always dropped. |
| **Inworld** | `Unsupported`. | Inline `/ipa/` rewrite. Only `ipa` entries honored; English-only. |
| **OpenAI** | `Unsupported`. | Silently dropped — no phoneme surface. |
| **Google** (`@effect-uai/google`) | `Unsupported`. | Silently dropped — Gemini API has no equivalent. Use Cloud TTS via `@effect-uai/google-speech` (coming) for native phoneme support. |
| **Hume** (future) | Planned: `utterances[]` with per-turn `description` + `speed`. | Phoneme support is preview, not yet on REST. |
| **Google Cloud TTS** (future, `@effect-uai/google-speech`) | Planned: Gemini-TTS multi-speaker markup. | Structured `customPronunciations` field; IPA + X-SAMPA. |

## Workspace voice IDs

ElevenLabs voice IDs are workspace-bound. The recipe uses two
commonly-provisioned premade voices (`JBFqnCBsd6RMkjVDRZzb` /
`EXAVITQu4vr4xnSDxMaL`); if your workspace doesn't have them you'll
get `voice_not_found` on the first request. List your voices via:

```sh
curl -H "xi-api-key: $ELEVENLABS_API_KEY" https://api.elevenlabs.io/v1/voices
```

and substitute IDs from the response.

## Run it

```sh
# Default: one-shot dialogue
ELEVENLABS_API_KEY=... pnpm tsx recipes/advanced-speech-synthesis/run-node.ts

# Streamed dialogue
ELEVENLABS_API_KEY=... pnpm tsx recipes/advanced-speech-synthesis/run-node.ts --mode dialogue-stream

# Both
ELEVENLABS_API_KEY=... pnpm tsx recipes/advanced-speech-synthesis/run-node.ts --mode both
```

Writes `out-dialogue.mp3` and/or `out-dialogue-stream.mp3` next to the
recipe.

## What this generalizes to

The recipe deliberately uses the **generic** `SpeechSynthesizer`
helpers, not `@effect-uai/elevenlabs`'s typed surface. Swapping in a
future Hume or Google Cloud TTS Layer at the runner level keeps
`index.ts` unchanged — same `synthesizeDialogue` + `pronunciations`
contract, different wire underneath.

Source: [`index.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/advanced-speech-synthesis/index.ts).
