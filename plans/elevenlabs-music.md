# Plan: ElevenLabs music provider + multi-provider music recipe

Adds `ElevenLabsMusicGenerator` as a second `MusicGenerator` implementation
alongside the existing Google Lyria layer, and converts the
`basic-music-generation` recipe to dispatch between the two via a
`--provider=` flag.

## 1. What's already in place

[packages/core/src/music-generator/MusicGenerator.ts](../packages/core/src/music-generator/MusicGenerator.ts)
is already provider-agnostic. Comments in
[packages/core/src/domain/Music.ts:17](../packages/core/src/domain/Music.ts#L17)
already anticipate ElevenLabs (`composition_plan`) and Suno (`song_id`),
so no abstraction changes are required.

[packages/providers/elevenlabs/](../packages/providers/elevenlabs/) already
ships TTS and STT. Reusable infra:

- [codec.ts](../packages/providers/elevenlabs/src/codec.ts):
  `formatToOutputSlug`, `transportFailure`, `httpStatusError`,
  `defaultFormat`.
- [region.ts](../packages/providers/elevenlabs/src/region.ts):
  `resolveHost` (music endpoints live on the same hosts as TTS).
- [models.ts](../packages/providers/elevenlabs/src/models.ts):
  `(string & {})` literal-with-fallback pattern.

The recipe body in
[recipes/basic-music-generation/index.ts](../recipes/basic-music-generation/index.ts)
already yields the generic `MusicGenerator`. Only the runner and docs
need to change; the Effect body is reusable as-is.

## 2. ElevenLabs Music API surface (verified from docs)

Sources:
[Compose music](https://elevenlabs.io/docs/api-reference/music/compose),
[Stream music](https://elevenlabs.io/docs/api-reference/music/stream),
[Compose detailed](https://elevenlabs.io/docs/api-reference/music/compose-detailed),
[Create composition plan](https://elevenlabs.io/docs/api-reference/music/create-composition-plan),
[Eleven Music overview](https://elevenlabs.io/docs/overview/capabilities/music).

### Endpoints

| Method + path                     | Purpose                                                                | Response                                              |
| --------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| `POST /v1/music`                  | Sync compose. Returns full audio bytes.                                | Binary audio in `output_format` (default mp3 44.1k).  |
| `POST /v1/music/stream`           | Streaming compose. Chunked progressive audio.                          | `text/event-stream` chunked binary.                   |
| `POST /v1/music/detailed`         | Sync compose returning audio + metadata.                               | `multipart/mixed` (JSON metadata + binary audio).     |
| `POST /v1/music/plan`             | Turn a prompt into a structured `MusicPrompt` composition plan. Free. | JSON `MusicPrompt`.                                   |

Auth: same `xi-api-key` header as TTS. Host resolved via existing
`resolveHost` (default / `eu` / `in` residency hosts).

### Request body (compose + stream)

| Field                       | Type                         | Default     | Notes                                                                |
| --------------------------- | ---------------------------- | ----------- | -------------------------------------------------------------------- |
| `prompt`                    | `string \| null`             |             | Mutually exclusive with `composition_plan`.                          |
| `composition_plan`          | `MusicPrompt \| null`        |             | Mutually exclusive with `prompt`.                                    |
| `music_length_ms`           | `integer \| null`            |             | `3000`-`600000`. Only with `prompt`.                                 |
| `model_id`                  | `string`                     | `music_v1`  | UI exposes `music_v2`; API default is still `v1`.                    |
| `seed`                      | `integer \| null`            |             | Determinism. Incompatible with prompt-only mode (docs not explicit). |
| `force_instrumental`        | `boolean`                    | `false`     | Hard switch.                                                         |
| `respect_sections_durations`| `boolean`                    | `true`      | Plan mode only.                                                      |
| `store_for_inpainting`      | `boolean`                    | `false`     | Enterprise.                                                          |
| `sign_with_c2pa`            | `boolean`                    | `false`     | Embeds C2PA signature in mp3 output.                                 |

Output format is a query string (`?output_format=mp3_44100_128`) just
like TTS. Supported: mp3 / wav / pcm / opus / mulaw / alaw at the usual
sample-rate matrix. `formatToOutputSlug` already covers all of them.

### `MusicPrompt` schema (composition plan)

```ts
type MusicPrompt = {
  positive_global_styles: ReadonlyArray<string>
  negative_global_styles: ReadonlyArray<string>
  sections: ReadonlyArray<SongSection>  // up to 30
}

type SongSection = {
  section_name: string                          // 1-100 chars
  positive_local_styles: ReadonlyArray<string>
  negative_local_styles: ReadonlyArray<string>
  duration_ms: number                           // 3000-120000
  lines: ReadonlyArray<string>                  // lyrics, max 200 chars / line
  source_from?: SectionSource                   // enterprise inpainting
}
```

Total duration: 3 s to 10 min via plan; 3 s to 5 min in the UI; 3 s to
10 min via `music_length_ms` on `/v1/music`. Pick the API limits.

### Models

- `music_v1` (API default today).
- `music_v2` (UI default; available via API once docs catch up).
- Custom and curated finetune IDs.

### Capabilities

- Languages: English, Spanish, German, Japanese, more (no enum, prompt
  it).
- Commercial-use cleared by default plan terms.
- No bidirectional session, ever. No `MusicInteractiveSession` marker.
- No SynthID-style mandatory watermark. C2PA only when
  `sign_with_c2pa: true` and only on mp3 output.

## 3. Provider package work

### 3.1 New file: `packages/providers/elevenlabs/src/ElevenLabsMusicGenerator.ts`

Mirror
[LyriaGenerator.ts](../packages/providers/google/src/LyriaGenerator.ts).
Approximate shape:

```ts
export type ElevenLabsMusicModel = "music_v1" | "music_v2" | (string & {})

export type ElevenLabsCompositionPlan = {
  readonly positiveGlobalStyles: ReadonlyArray<string>
  readonly negativeGlobalStyles: ReadonlyArray<string>
  readonly sections: ReadonlyArray<{
    readonly sectionName: string
    readonly positiveLocalStyles: ReadonlyArray<string>
    readonly negativeLocalStyles: ReadonlyArray<string>
    readonly durationMs: number
    readonly lines: ReadonlyArray<string>
  }>
}

export type ElevenLabsMusicGenerateRequest =
  Omit<CommonGenerateMusicRequest, "model"> & {
    readonly model?: ElevenLabsMusicModel
    readonly compositionPlan?: ElevenLabsCompositionPlan
    readonly seed?: number
    readonly signWithC2pa?: boolean
    readonly respectSectionsDurations?: boolean
  }

export type ElevenLabsMusicGeneratorService = {
  readonly generate: (r: ElevenLabsMusicGenerateRequest)
    => Effect.Effect<MusicResult, AiError.AiError>
  readonly streamGeneration: (r: ElevenLabsMusicGenerateRequest)
    => Stream.Stream<AudioChunk, AiError.AiError>
  readonly streamGenerationFrom: <E, R>(
    input: Stream.Stream<MusicSessionInput, E, R>,
    request: CommonStreamGenerateMusicRequest,
  ) => Stream.Stream<AudioChunk, AiError.AiError | E, R>  // always Unsupported
  /** Free helper: turn a prompt into a structured composition plan. */
  readonly createCompositionPlan: (input: {
    readonly prompt: string
    readonly musicLengthMs?: number
    readonly model?: ElevenLabsMusicModel
  }) => Effect.Effect<ElevenLabsCompositionPlan, AiError.AiError>
}
```

Mapping `CommonGenerateMusicRequest` → wire body:

| Common field             | Wire field            | Rule                                                                                                |
| ------------------------ | --------------------- | --------------------------------------------------------------------------------------------------- |
| `prompts: string`        | `prompt`              | Pass through.                                                                                       |
| `prompts: WeightedPrompt[]` | `prompt`           | Flatten like Lyria's `buildPrompt` (`"text (weight N)"` join). No weighted-blend field on the wire. |
| `lyrics`                 | `prompt` suffix       | Append `Lyrics:\n…` like Lyria. Or if `compositionPlan` is set, ignore (caller owns `lines`).       |
| `durationSeconds`        | `music_length_ms`     | `* 1000`. Reject when `compositionPlan` is also set.                                                |
| `bpm`, `scale`           | `prompt` suffix       | Inline hints. No structured fields exist.                                                           |
| `instrumental`           | `force_instrumental`  | Direct.                                                                                             |
| `outputFormat`           | `?output_format=…`    | Reuse `formatToOutputSlug`.                                                                         |
| `model`                  | `model_id`            | Default to `music_v1`.                                                                              |

Errors:

- `compositionPlan` + (`prompt-derived prompt` from `prompts`, `lyrics`,
  `durationSeconds`, `bpm`, `scale`) → `InvalidRequest` at the codec
  layer, mirror Lyria's prompt-flatten failures.
- HTTP status mapping: reuse `httpStatusError` (already handles 401 /
  403 / 408 / 429 / 5xx with the right `AiError` subtypes). Add a
  `provider: "elevenlabs-music"` tag so 422 validation errors are easy
  to spot in logs.

Streaming impl:

- `streamGeneration` is real. `POST /v1/music/stream`, hand
  `response.stream` straight back as `Stream<AudioChunk>` (each chunk
  wrapped in `{ bytes }`). Unlike Lyria, no fake single-chunk fallback.
- Content-Type advertised as `text/event-stream` but body is plain
  chunked binary; treat as a raw byte stream.

`streamGenerationFrom`: identical pattern to Lyria's
[`streamGenerationFromUnsupported`](../packages/providers/google/src/LyriaGenerator.ts#L334):
fail `AiError.Unsupported`, do not register
`MusicInteractiveSession` on the Layer, so callers get a compile-time
error against the Layer alone.

### 3.2 New file: `packages/providers/elevenlabs/src/musicCodec.ts`

Wire codec for `composition_plan` (snake-case mapping) and the prompt
flattener. Kept separate from the existing `codec.ts` (TTS) so the file
doesn't blur two surfaces.

### 3.3 Updates: existing files

- [models.ts](../packages/providers/elevenlabs/src/models.ts): add
  `ElevenLabsMusicModel` next to the existing TTS / STT literals.
- [index.ts](../packages/providers/elevenlabs/src/index.ts): add
  `export * as ElevenLabsMusicGenerator from "./ElevenLabsMusicGenerator.js"`.
- [package.json](../packages/providers/elevenlabs/package.json):
  - `description` adds "music generation".
  - `keywords` add `"music"`.
  - `exports`: add `./ElevenLabsMusicGenerator` entry mirroring the
    existing synthesizer/transcriber entries.

### 3.4 Tests: `ElevenLabsMusicGenerator.test.ts`

Coverage shape matches
[LyriaGenerator.test.ts](../packages/providers/google/src/LyriaGenerator.test.ts):

- Codec: prompt flatten with weights / hints / lyrics; composition-plan
  passthrough; `outputFormat` slugging; conflict detection between
  `compositionPlan` and prompt-derived hints.
- HTTP: sync happy path, streaming happy path (chunk count),
  per-status error mapping (401, 422, 429, 503, 504).
- Type-level: `streamGenerationFrom` against the music-only Layer is a
  type error (vitest `expectTypeOf`). No scratch files (per repo
  convention).

## 4. Recipe work

[recipes/basic-music-generation/](../recipes/basic-music-generation/)
turns into a two-provider recipe.

### 4.1 `index.ts`

Drop the hard-coded model literal from
[index.ts:53](../recipes/basic-music-generation/index.ts#L53) and
[index.ts:61](../recipes/basic-music-generation/index.ts#L61). Take a
`model` parameter on `runSimple` / `runWeighted`, default in the
runner.

### 4.2 `run-node.ts`

Add a `--provider=` CLI flag:

```sh
pnpm tsx run-node.ts                                        # default google
pnpm tsx run-node.ts --provider=google
pnpm tsx run-node.ts --provider=elevenlabs
pnpm tsx run-node.ts --provider=elevenlabs ./my-prompt.txt
pnpm tsx run-node.ts --provider=elevenlabs ./my-track.json
```

Per-provider wiring inside the runner:

| Branch                  | Layer                                  | Env var              | Default model         |
| ----------------------- | -------------------------------------- | -------------------- | --------------------- |
| `--provider=google`     | `@effect-uai/google/LyriaGenerator`    | `GOOGLE_API_KEY`     | `lyria-3-clip-preview`|
| `--provider=elevenlabs` | `@effect-uai/elevenlabs/ElevenLabsMusicGenerator` | `ELEVENLABS_API_KEY` | `music_v1`            |

Output filenames are suffixed with the provider for easy A/B
comparison: `out-simple-google.mp3`, `out-simple-elevenlabs.mp3`,
`out-weighted-google.mp3`, `out-weighted-elevenlabs.mp3`.

### 4.3 `README.md`

Update the section "What This Generalizes To" to show both providers
side by side. Spell out the differences:

- Lyria: SynthID watermark always present, 30 s fixed for clip model.
- ElevenLabs: optional C2PA via `signWithC2pa`, real streaming, 3 s to
  10 min, composition-plan input available.

## 5. Docs work

### 5.1 New: `docs/music-generation/providers/elevenlabs.md`

Mirror [gemini.md](../docs/music-generation/providers/gemini.md). Cover:

- Endpoints used (`/v1/music`, `/v1/music/stream`, `/v1/music/plan`).
- Default model and how to opt into `music_v2`.
- Output-format slug table.
- Composition-plan example (showing the difference between prompt mode
  and plan mode).
- C2PA opt-in note.
- Why `streamGenerationFrom` is unsupported (no bidi at the wire).

### 5.2 Update: `docs/music-generation/index.md`

The current line at
[docs/music-generation/index.md:9](../docs/music-generation/index.md#L9)
calls out Lyria only. Reword to "Google Lyria and ElevenLabs Music".
Keep the `MusicInteractiveSession` note: neither provider ships the
marker today.

## 6. Skill work

[skills/effect-uai-basic-music-generation](../skills/effect-uai-basic-music-generation/)
gets a sub-section showing the multi-provider switch. The master
skill's cheat-sheet table gets an extra row for
`ElevenLabsMusicGenerator`.

## 7. Changeset

- `@effect-uai/elevenlabs`: minor bump. Body: "Add Eleven Music
  provider (`ElevenLabsMusicGenerator`). Wires `MusicGenerator.generate`
  and `streamGeneration`. Native chunked streaming. Composition-plan
  input. `createCompositionPlan` helper. No bidirectional session."
- `@effect-uai/core`: no version bump unless `Music.ts` doc-comments
  change. The wire surface stays as-is.

## 8. Open questions to resolve before coding

1. **`music_v2` rollout.** Docs say API default is still `music_v1`,
   UI default is `music_v2`. Ship `music_v2` in the literal list now,
   or wait until ElevenLabs flips the API default? Recommendation:
   include it. The `(string & {})` tail keeps it forward-compatible
   either way.
2. **`createCompositionPlan` as provider extra.** Belongs on
   `ElevenLabsMusicGeneratorService`, not the generic `MusicGenerator`.
   Confirm OK to expose it as a provider-only method (precedent:
   `LyriaGenerator` exposes no extras today). Recommendation: ship it.
   The endpoint is free and the typed return value pairs cleanly with
   `compositionPlan` on the generate request.
3. **`/v1/music/detailed` multipart endpoint.** Returns audio + metadata
   (lyrics with timestamps, plan used, etc.). Useful for surfacing
   `lyrics` / `sections` on `MusicResult`, but the multipart parser is
   non-trivial. Recommendation: skip for v1, add as a follow-up. v1
   leaves `MusicResult.lyrics` / `sections` undefined for ElevenLabs.
4. **C2PA representation.** When `signWithC2pa: true`, surface as
   `result.watermark = { kind: "c2pa" }`. Otherwise leave undefined.
   Aligns with Lyria's `{ kind: "synthid" }` convention.
5. **Recipe weighted-prompt mapping.** ElevenLabs has no weighted
   field. Flattening loses information that Lyria would have used.
   Document the lossy mapping in the recipe README so users picking
   ElevenLabs know the `weight` is advisory only.

## 9. Effort estimate

- Provider impl + codec + tests: ~500 lines, half a day.
- Recipe runner refactor: ~80 lines, an hour.
- Docs + skill updates: 2 new pages, 2 edits, an hour.
- Changeset + release: trivial.

Total: about one focused day.
