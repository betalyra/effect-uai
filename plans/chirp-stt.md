# Plan: Google Cloud Speech-to-Text (Chirp) adapter

**Status: design only — implementation deferred.** This plan exists so
the design space is reserved; no code lands from it yet.

Companions: [stt-revamp.md](./stt-revamp.md) (removes the incorrect
Gemini transcriber that this replaces) · [stt-tts.md](./stt-tts.md)
(the original packaging decision — §"google-cloud-speech") ·
[stt-tts-wire.md](./stt-tts-wire.md) ("Google Cloud STT" section — the
verified `recognize` / `StreamingRecognize` wire shapes).

## 1. Why

The `@effect-uai/google` `GeminiTranscriber` was **removed**
([stt-revamp.md](./stt-revamp.md)): it rode on `:generateContent`, an
open-ended LLM, and faked transcription with a hardcoded instruction.
That's a category error — an LLM prompted to transcribe is not a
transcription API.

The real Google STT is **Cloud Speech-to-Text V2** with the **`chirp_3`**
model ([official docs](https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3),
[transcription-model](https://docs.cloud.google.com/speech-to-text/docs/transcription-model)):
a dedicated ASR API with native speaker diarization, automatic language
detection, word-level offsets, model adaptation (phrase biasing), and
all three recognition methods (`Recognize` / `StreamingRecognize` /
`BatchRecognize`), 85+ languages. It's a genuine `Transcriber` backend —
and the first in-tree provider that ships the diarization /
word-timestamp markers honestly (per-Layer, every routable model).

## 2. Packaging — separate package, official SDK, optional cost

Per [stt-tts.md](./stt-tts.md): Cloud Speech requires gRPC
(`@google-cloud/speech` → `google-gax` → `@grpc/grpc-js`, ~3 MB; works
on Node/Bun/Deno, **not** browsers / CF Workers / Vercel Edge). It must
not be a hard dependency of `@effect-uai/google` (REST/JSON, runs
everywhere).

Two options; decide at implementation time:

- **A. Separate package `@effect-uai/google-cloud-speech`** (stt-tts.md's
  call). Depends on the official `@google-cloud/speech` SDK (ships
  generated proto types, ADC handling, retry). Cleanest isolation; no
  optional-peer gymnastics. **Recommended.**
- **B. Optional peer dep inside `@effect-uai/google`** — `@google-cloud/speech`
  as `peerDependenciesMeta.optional`, reachable only via a
  `ChirpTranscriber` subpath, same pattern as the `ws` dep for realtime
  STT ([stt-tts.md](./stt-tts.md) §peer-deps). LLM-only users never
  import the subpath, so they never pull gRPC.

Either way the principle holds: **you pay for gRPC only if you use
Cloud Speech.** Lean A unless we want to keep all Google under one
package name.

## 3. Auth

OAuth2 / ADC — **no API key path** (the big divergence from the Gemini
adapter's `Redacted` key). The official SDK resolves Application Default
Credentials automatically; `Config` carries a project id + optional
explicit credentials/token. Document the ADC setup.

## 4. Common mapping

`recognize` (sync, <60 s) first; `StreamingRecognize` (gRPC bidi) as a
fast-follow since the SDK makes it tractable.

| Common field | Chirp / Cloud STT V2 |
|---|---|
| `model` | `RecognitionConfig.model` (`"chirp_3"`, narrowed union) |
| `language` | `languageCodes: [code]` (or `["auto"]` for detection) |
| `prompt { terms }` | `adaptation.phraseSets[].inlinePhraseSet.phrases[].value` (+ optional `boost`) |
| `prompt` (string) | no structured home → `warnDropped` |
| `diarization` | `features.diarizationConfig` (min/maxSpeakerCount) |
| `wordTimestamps` | `features.enableWordTimeOffsets` |
| `audio` | `content` (base64) or `uri` (`gs://` only) |
| word offsets | `"1.200s"` strings → parse to seconds / `Duration` |

## 5. Markers (when Phase 2 lands)

Chirp ships, per-Layer (every routable Chirp model honors them):

- `SttStreaming` (StreamingRecognize)
- `DiarizationGuarantee`
- `WordTimestampsGuarantee`

This is what turns the postponed STT markers from "ElevenLabs-only" into
genuinely discriminating — Chirp is the clean reference shipper.

## 6. Scope / sequencing (when picked up)

1. Package scaffold (decide A vs B §2); `@google-cloud/speech` dep; ADC `Config`.
2. Sync `recognize`: Common → `RecognitionConfig`, response → `TranscriptResult`, `"1.200s"` → seconds/`Duration`.
3. `warnDropped` the free-form `prompt` string; map `{ terms }` → `adaptation`.
4. `StreamingRecognize` (gRPC bidi) → `Stream<TranscriptEvent>`; ship `SttStreaming`.
5. Markers (gated on STT Phase 2): `DiarizationGuarantee`, `WordTimestampsGuarantee`.
6. Recipe + tests.

## 7. Out of scope

Cloud TTS (Chirp 3 HD streaming voices) — same package/SDK, separate
plan when TTS revamp reaches it ([stt-tts.md](./stt-tts.md) covers it).
