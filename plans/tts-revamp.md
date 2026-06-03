# Plan: SpeechSynthesizer (TTS) capabilities revamp

Companions: [capabilities.md](./capabilities.md) (the guideline) ·
[stt-revamp.md](./stt-revamp.md) (sibling, same method) ·
[music-revamp.md](./music-revamp.md) (sibling) ·
[stt-tts-wire.md](./stt-tts-wire.md) (wire shapes, 2026-05-11; §3 is
grounded in it plus the in-tree adapter inventory).

> **Read this first.** Unlike STT, the TTS surface is **already
> mature**. Both service-level markers (`TtsIncrementalText`,
> `MultiSpeakerTts`) are in tree and pessimistically registered;
> `model` and `voiceId` are narrowed on every provider request; the
> dialogue methods exist; and the result type is `AudioBlob`, which
> already moved to `Duration` in the music revamp. So this is **not a
> structural rework**. It is a focused runtime-correctness pass whose
> headline is capabilities §14.1: **pronunciations are mis-classified
> as a silent drop on all four adapters and must become bucket-1
> `Unsupported`.** Everything else is small.

TTS now has **4 providers / 6 Layers** in tree: OpenAI (sync+chunked),
Gemini (sync-only), ElevenLabs (sync+chunked+rt+dialogue), Inworld
(sync+chunked, rt).

---

## 1. Current state

### 1.1 Right, keep as-is

- **One service, five methods** (`synthesize`, `streamSynthesis`,
  `streamSynthesisFrom`, `synthesizeDialogue`, `streamSynthesizeDialogue`).
  Two service-level markers gate the optional methods:
  `TtsIncrementalText` on `streamSynthesisFrom`, `MultiSpeakerTts` on
  the two dialogue methods.
  [SpeechSynthesizer.ts:103-181](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L103).
- **Marker registration is correct and pessimistic** (verified):

  | Layer | `TtsIncrementalText` | `MultiSpeakerTts` |
  |---|---|---|
  | OpenAI | ✗ (no incremental wire) | ✗ (no multi-speaker) |
  | Gemini | ✗ (sync-only) | ✗ (generativelanguage has none) |
  | ElevenLabs | ✓ (`/stream-input` WS) | ✓ (`/v1/text-to-dialogue`) |
  | Inworld sync / rt | ✗ / ✓ | ✗ / ✗ |

- **`model` + `voiceId` narrowed** on every provider request
  (`Omit<…,"model"|"voiceId"> & { model: <Union>; voiceId: <Union> }`).
  Providers without custom voices (OpenAI, Gemini) narrow `voiceId` to
  a stock-only union; cloning providers add the `(string & {})` escape.
  §3.4 done.
- **`outputFormat` is bucket-1, already correct.** Per-adapter codec
  rejection translates un-encodable formats to `Unsupported`
  ([Gemini:65-74](../packages/providers/google/src/GeminiSynthesizer.ts#L65),
  plus the codec rejections cited in capabilities §13).
- **Result type needs no `Duration` migration.** `synthesize` returns
  `AudioBlob`, which already carries `duration?: Duration.Duration` from
  the music revamp. There is no TTS-side `durationSeconds: number` to
  migrate (this is the one piece of STT-revamp work that does not recur
  here).
- **No per-modifier markers, and none planned.** Per capabilities §4,
  every TTS modifier is bucket 1, 2, or 3, not a marker case
  (pronunciations are load-bearing data, not a feature gate; speed /
  language / instructions are tuning hints). §7 lists zero per-modifier
  TTS markers. This stays.

### 1.2 What changes

- **Pronunciations: collapse to IPA, then `Unsupported` (§2.1).** The
  central fix, in two parts. (1) Common-shape: drop the
  `"ipa" | "x-sampa" | "cmu-arpabet"` encoding enum and standardize on
  IPA (X-SAMPA is mechanically derivable, CMU Arpabet exits with the
  legacy models). (2) Runtime: load-bearing data per §14.1, so a
  provider with no stateless IPA path returns bucket-1 `Unsupported`
  rather than silently mispronouncing. Today all four adapters drop
  silently in at least one path.
- **Pronunciations uniform across all methods (§2.2).** Post-collapse
  the rule is the same on sync, incremental, and dialogue: render inline
  IPA or `Unsupported`. No path-specific or per-model branching.
- **Gemini bucket-2 silent drops: `speed`, `languageCode` (§2.3).**
  `ttsBody` sends neither (Gemini `:generateContent` has no field for
  either), so both vanish silently. Per §14.5 they should `warnDropped`.
  OpenAI also drops `languageCode` (no wire field) silently: same fix.
- **OpenAI `instructions` per-model honor (§2.4).** Honored only by
  `gpt-4o-mini-tts`; silently ignored on `tts-1` / `tts-1-hd`. §14.5
  lists it as a warn case. Small, and in tension with the "no per-model
  tables" rule (§2.3): settled as leave-silent.
- **`DialogueTurn` provider-specific fields (§2.5).** `styleDescription`
  and `speed` on `DialogueTurn` are Hume-shaped: honored only by Hume
  Octave-2, silently ignored by the only in-tree dialogue provider
  (ElevenLabs `/v1/text-to-dialogue` accepts `{ voice_id, text }` only)
  and by Google. They are speculative single-provider fields on a Common
  type, with zero in-tree honorers. Remove them; reintroduce on a
  Hume-typed turn extension when that adapter lands.

### 1.3 What was considered and rejected

- **Factoring `SpeechSynthesizer` into `…Sync` + `…Realtime` (or a
  separate `DialogueTts`) services.** Capabilities §9.1 and open
  question §11 raise this. The marker pattern already hits the goal
  (methods you cannot call are a compile-time error against a Layer
  that omits the marker) with less ceremony than forcing callers to
  thread multiple services. **Keep the single service.** This resolves
  capabilities §11 for TTS.
- **A per-modifier `PronunciationGuarantee` marker.** Rejected by
  capabilities §4 explicitly: pronunciations are load-bearing data, not
  a feature gate, so the bucket-1 runtime `Unsupported` is the right
  surface, not a compile-time marker.

---

## 2. Changes

### 2.1 Pronunciations: collapse to IPA, then bucket-1 `Unsupported`

Two coupled changes: a Common-shape simplification first, then the
runtime rule.

**Collapse the caller-facing encoding to IPA only.** Today
`CustomPronunciation` carries
`encoding: "ipa" | "x-sampa" | "cmu-arpabet"`. That enum is unnecessary:

- **X-SAMPA is an ASCII re-encoding of IPA** (identical expressive
  power, bijective lookup). Adapters whose wire wants X-SAMPA (Google
  `<phoneme alphabet="x-sampa">`, Azure) convert IPA to X-SAMPA
  internally via one lossless table. The caller never supplies X-SAMPA.
- **CMU Arpabet is English-only** and used solely by the ElevenLabs
  legacy models, which we are dropping (per decision). It exits the
  library with them.

So drop the enum and the field:

```ts
// before
export type PhoneticEncoding = "ipa" | "x-sampa" | "cmu-arpabet"
export type CustomPronunciation = {
  readonly phrase: string
  readonly pronunciation: string
  readonly encoding: PhoneticEncoding
}
// after
export type CustomPronunciation = {
  readonly phrase: string
  /** IPA. Adapters convert to the provider's wire form (e.g. X-SAMPA
   *  for Google / Azure) or fail `Unsupported` if the provider has no
   *  stateless phoneme path. */
  readonly pronunciation: string
}
```

IPA is the universal interchange format; every modern phoneme-capable
provider accepts it (directly, or via the internal X-SAMPA conversion).
This closes the **alphabet** axis of the leak entirely: one encoding, so
no per-encoding rejection.

Not branded. A runtime-validating `Ipa` smart constructor is
heavyweight (IPA is a large, fuzzy Unicode set; the provider validates
anyway), and the real safety came from collapsing to one encoding, not
from a brand. Plain documented `string`.

**Then the runtime rule (capabilities §2.2 / §14.1).** With one
encoding the only remaining question is per-provider: does this provider
have a *stateless* phoneme mechanism that accepts IPA? If yes, render
it; if no, a non-empty `pronunciations` is bucket-1 `Unsupported`
(silent drop = the caller's configured word spoken wrong = broken
audio). Partial honor is unacceptable, so any unrenderable entry fails
the whole call.

Per adapter:

- **Inworld** ([InworldSynthesizer.ts:85-95](../packages/providers/inworld/src/InworldSynthesizer.ts#L85)):
  inline `/ipa/` tokens, stateless, IPA-native. Supported. Drop the
  silent-skip branch (every entry is now IPA by construction).
- **OpenAI** ([OpenAISynthesizer.ts:84-99](../packages/providers/openai/src/OpenAISynthesizer.ts#L84)):
  no phoneme surface at all (`buildBody` never reads `pronunciations`).
  Non-empty `pronunciations` becomes `Unsupported`. (Makes the
  aspirational Common doc comment on
  [SpeechSynthesizer.ts:55-61](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L55)
  true.)
- **Gemini**: `:generateContent` TTS has no phoneme surface →
  `Unsupported`.
- **ElevenLabs** ([ElevenLabsSynthesizer.ts:99-113](../packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L99)):
  the legacy inline-SSML path is dropped, and there is no stateless
  inline IPA path, so inline `pronunciations` becomes `Unsupported`.
  Remove the `PHONEME_SUPPORTED_MODELS` table and `applyPronunciations`
  rewrite. **Separately**, expose the dictionary as an ElevenLabs-typed
  provider extra (§2.2): a `pronunciationDictionaryLocators` field on
  `ElevenLabsSynthesizeRequest` that maps straight to the wire
  `pronunciation_dictionary_locators`. The two are orthogonal: the
  caller can pass locators (honored) and would still get `Unsupported`
  for inline IPA `pronunciations`. We do **not** provision or upload
  dictionaries; the caller does that out-of-band (dashboard or their own
  API call) and passes the resulting IDs.
- **Google (future)**: IPA inline `<phoneme>` or structured
  `customPronunciations`; X-SAMPA via the internal conversion.
  Supported.

Shape: a small **per-adapter** helper (settled §5.3, no shared core
util). For IPA-native providers it inlines (and converts to X-SAMPA
where the wire needs it); for no-stateless-phoneme providers it is a
one-line "non-empty → `Unsupported`". The IPA-to-X-SAMPA table is the
one piece worth sharing if a second X-SAMPA provider lands.

**Why fail rather than degrade (the fallback tension).** Failing loud
makes provider fallback during an outage trickier: a fallback target
without pronunciation support now errors instead of returning degraded
audio. That trade is correct anyway. Pronunciation correctness is an
adapter contract; fallback is a recipe-level policy, and the two belong
at different layers. Making the adapter lax to ease fallback shifts an
invisible cost onto every non-fallback caller (silently wrong audio for
a brand or drug name, the worst failure mode: undetectable in dev,
caught by a customer). A loud `Unsupported` is trivially recoverable.
Fallback recovers cleanly at the right layer: catch outage-class errors
only (`Unavailable` / `RateLimited` / `Timeout`), never `Unsupported`
(same line [stt-revamp §1.3](./stt-revamp.md) drew dropping the
`fallback` combinator); and an operator who wants "degrade
pronunciations on fallback" strips `pronunciations` before the fallback
call, making the degradation visible and chosen. If a real consumer
needs degraded-but-succeeding output, add a caller-controlled
best-effort opt-in then; do not invert the default to lax. YAGNI until
asked.

**What is left of the leak after the collapse.** The alphabet axis is
closed (one encoding, IPA). The remaining divergence is internal and not
caller-visible: delivery (inline `/ipa/` token vs inline `<phoneme>`
SSML vs structured `customPronunciations`) is the adapter's translation
job, and statefulness (dictionary / lexicon providers need a prior
upload call, so they cannot honor inline IPA from one stateless
`synthesize`) collapses into a single provider-level `Unsupported`. So
the caller-visible contract reduces to one bit: **this provider renders
inline IPA, or it does not.** No per-encoding, no per-model branching
survives on the caller's side.

| Provider | Inline IPA path | Result |
|---|---|---|
| Inworld | `/ipa/` token, stateless | supported |
| Google (future) | `<phoneme>` / `customPronunciations` (+IPA→X-SAMPA) | supported |
| OpenAI, Gemini | none | `Unsupported` |
| ElevenLabs | dictionary only (stateful, model-limited) | `Unsupported` (defer dict) |
| MiniMax (future) | bespoke `pronunciation_dict.tone` (no IPA) | `Unsupported` |

### 2.2 Pronunciations on the non-sync paths (§14.1, same bucket)

Post-collapse, ElevenLabs has no stateless inline IPA path on **any**
method (legacy SSML dropped, dictionaries are stateful), so the rule is
uniform across sync, incremental, and dialogue: non-empty
`pronunciations` becomes `Unsupported`. No path-specific logic.

- **ElevenLabs `streamSynthesisFrom`** ([realtimeTts.ts](../packages/providers/elevenlabs/src/realtimeTts.ts))
  and **dialogue** ([ElevenLabsSynthesizer.ts:135-142](../packages/providers/elevenlabs/src/ElevenLabsSynthesizer.ts#L135)):
  both silently drop today; both become `Unsupported` (settled §5.1).
  The dialogue default model `eleven_v3` was never phoneme-capable
  anyway, so this only makes an already-100%-silent drop loud.
- **Inworld rt** ([InworldRealtimeSynthesizer.ts](../packages/providers/inworld/src/InworldRealtimeSynthesizer.ts)):
  the BOS `create` frame reuses `InworldSynthesizer.buildBody`
  (IPA-native), so the §2.1 fix covers it for free, supported.

**ElevenLabs dictionary locators (in scope, as a provider extra).**
ElevenLabs' modern structured path is `pronunciation_dictionary_locators`,
present on both the sync body and the WS BOS frame
([stt-tts-wire.md:536](./stt-tts-wire.md#L536), [:591](./stt-tts-wire.md#L591)).
We expose it as an ElevenLabs-typed extra and wire it on `synthesize`,
`streamSynthesis`, and `streamSynthesisFrom`:

```ts
export type ElevenLabsSynthesizeRequest = Omit<…, "model" | "voiceId"> & {
  // …existing extras (voiceSettings, seed, previousText, nextText)…
  /** References to pre-provisioned pronunciation dictionaries. The
   *  caller provisions them out-of-band (dashboard or the ElevenLabs
   *  pronunciation-dictionary API); this library only references by ID. */
  readonly pronunciationDictionaryLocators?: ReadonlyArray<{
    readonly dictionaryId: string
    readonly versionId: string
  }>
}
```

We deliberately do **not** wrap the dictionary lifecycle
(`add-from-file` / `add-from-rules`, versioning): that is the caller's
concern. We only pass the IDs through. Note phoneme rules inside a
dictionary remain model-limited on ElevenLabs' side (alias rules are
universal text replacement); that is the caller's dictionary content to
manage, not our gate. The dialogue endpoint is left out (the wire doc
documents locators on the TTS body and WS BOS, not
`/v1/text-to-dialogue`).

**Referenced-lexicon pattern: per-provider extra, not Common.** The
"provision a lexicon out-of-band, reference it by a handle on the
request" pattern is not ElevenLabs-only. Three providers share the
concept with structurally different handles:

| Provider | Handle | Provisioned via |
|---|---|---|
| ElevenLabs | `pronunciation_dictionary_locators: [{ id, version_id }]` | pronunciation-dictionary API |
| AWS Polly | `LexiconNames: string[]` (≤5) | `PutLexicon` (PLS) |
| Azure | `<lexicon uri="…"/>` in SSML | hosted lexicon file |

These stay **per-provider typed extras**, not a Common field (only 3 of
9 providers, and the handle shapes diverge too far to unify: compound
ID+version vs bare name vs URI). Establish the pattern consistently as
adapters land: `ElevenLabsSynthesizeRequest.pronunciationDictionaryLocators`
now, `PollySynthesizeRequest.lexiconNames` and an Azure lexicon-URI extra
later, each shaped to its own wire. By contrast Google
(`customPronunciations`), MiniMax (`pronunciation_dict`), and Inworld
(`/ipa/`) carry pronunciation **inline** with no separate resource, so
they need no such extra.

### 2.3 Gemini / OpenAI bucket-2 silent drops (§14.5)

- **Gemini** ([GeminiSynthesizer.ts:112-118](../packages/providers/google/src/GeminiSynthesizer.ts#L112)):
  `ttsBody` sends neither `speed` nor `languageCode`. Gemini
  `:generateContent` TTS has no structural field for either, so both are
  bucket-2 (provider has no interpretation). Add `warnDroppedWhen` for
  each.
- **OpenAI** ([OpenAISynthesizer.ts:84-99](../packages/providers/openai/src/OpenAISynthesizer.ts#L84)):
  `buildBody` sends `speed` but not `languageCode` (OpenAI `/audio/speech`
  has no language param; it auto-detects). `languageCode` is bucket-2:
  add `warnDroppedWhen`.
- ElevenLabs and Inworld both pass `languageCode` and `speed`
  structurally: no change.

`warnDroppedWhen` from
[capabilities/Capabilities.ts](../packages/core/src/capabilities/Capabilities.ts),
same helper STT used.

### 2.4 OpenAI `instructions` per-model honor: leave silent (settled)

`instructions` is an OpenAI-typed extra honored only by
`gpt-4o-mini-tts` and silently ignored on `tts-1` / `tts-1-hd`
([OpenAISynthesizer.ts:33-37](../packages/providers/openai/src/OpenAISynthesizer.ts#L33)).
§14.5 floats it as a warn case, but **leave it silent (settled).** It
is a provider-typed extra, so a caller reaching for the OpenAI request
type is already close to the model semantics; a per-model warn here
would also reintroduce the kind of per-model branching §2.3 steers away
from for a degradation-only field. No change to the adapter.

### 2.5 Trim `DialogueTurn` provider-specific fields

`DialogueTurn`
([SpeechSynthesizer.ts:83-88](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L83))
carries `styleDescription?` and `speed?`. Its own doc comment concedes
both are honored only by Hume Octave-2 and silently ignored elsewhere.
The only in-tree dialogue provider, ElevenLabs `/v1/text-to-dialogue`,
takes `{ voice_id, text }` per turn and drops both; Google multi-speaker
has no per-turn styling either. So these are **speculative,
single-provider fields on a Common type with zero in-tree honorers** (a
§14.5 hidden bucket-2 drop, and the "one-provider attribute on Common"
antipattern).

```ts
// before
export type DialogueTurn = {
  readonly voiceId: string
  readonly text: string
  readonly styleDescription?: string  // Hume-only, drop
  readonly speed?: number             // Hume-only, drop
}
// after
export type DialogueTurn = {
  readonly voiceId: string
  readonly text: string
}
```

Reintroduce both on a Hume-typed turn extension (the same typed-extras
pattern OpenAI `instructions` / ElevenLabs `voiceSettings` already
follow) when the Hume adapter lands. The rest of the request
(`CommonSynthesizeDialogueRequest`: `model`, `turns`, `outputFormat`,
`languageCode`, `pronunciations`) stays as-is and remains behind the
`MultiSpeakerTts` marker.

This is the second Common-shape change (the first being the
`CustomPronunciation` encoding collapse, §2.1). The main
`CommonSynthesizeRequest` was otherwise audited field-by-field (`text`,
`model`, `voiceId`, `outputFormat`, `speed`, `languageCode`,
`pronunciations`) and every field is genuinely cross-provider;
provider-specifics already live in typed extras.

### 2.6 Non-changes (record so they are not re-litigated)

- No `Duration` migration (already done via `AudioBlob`, §1.1).
- No new markers, no per-modifier markers (§1.1, capabilities §4/§7).
- No service split (§1.3, resolves capabilities §11 for TTS).
- `synthesizeDialogue` stays a marker-gated method, not its own service.

---

## 3. Cross-provider matrix

### 3.1 In-tree (post-change adapter behavior)

S structured wire field · I inline-rewrite (text) · U `Unsupported` ·
W `warnDropped` · — not applicable

| | OpenAI | Gemini | ElevenLabs | Inworld sync | Inworld rt |
|---|---|---|---|---|---|
| `voiceId` | S (stock) | S (stock) | S (+clone) | S (+clone) | S (+clone) |
| `outputFormat` | S / U | raw·wav / U | S / U | S / U | S / U |
| `speed` | S | W | S | S | S |
| `languageCode` | W | W | S | S | S |
| `pronunciations` (IPA) | U | U | U (dict deferred) | I (`/ipa/`) | I (`/ipa/`) |
| `streamSynthesis` (chunked) | S | wrap-sync | S | S | S |
| `streamSynthesisFrom` (incr) | — | — | S | — | S |
| `synthesizeDialogue` | — | — | S | — | — |

(`pronunciations` is now IPA-only, §2.1. Cells: Inworld inlines IPA on
every method; the rest have no stateless IPA path, so `Unsupported`.
The previous per-encoding silent-drop behavior is gone.)

### 3.2 Expansion providers (grounded in [stt-tts-wire.md](./stt-tts-wire.md)
plus the `CustomPronunciation` inventory in
[SpeechSynthesizer.ts:5-31](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L5))

S structured · I inline SSML · × unsupported

| | Google Cloud TTS | Cartesia | Hume Octave | AWS Polly | Azure | MiniMax |
|---|---|---|---|---|---|---|
| custom voice / clone | S | S | S | × | S | S |
| `pronunciations` (IPA in) | S `customPronunciations` / SSML (IPA, or IPA→X-SAMPA) | I (IPA) | × | I SSML (IPA) + lexicons | I SSML (IPA→X-SAMPA) | × (bespoke tone syntax, no IPA) |
| incremental text-in | S (Chirp 3 HD gRPC) | S (WS) | × | × | S (SDK) | S |
| multi-speaker dialogue | S (Gemini TTS markup) | × | S (`utterances[]`) | × | × | × |
| per-turn timing | × | × | S | × | × | × |

Google Cloud TTS is the one provider with a *structured*
pronunciation field (`customPronunciations`), which would honor a
`pronunciations` array natively rather than via fragile inline
rewrite. It is also the strongest future marker shipper for incremental
text-in (Chirp 3 HD, the same gRPC surface as
[chirp-stt.md](./chirp-stt.md)). Both are separate efforts and do not
block this plan.

---

## 4. Sequencing

1. **Domain: collapse `CustomPronunciation` to IPA (§2.1).** Drop
   `PhoneticEncoding` and the `encoding` field from
   [SpeechSynthesizer.ts:5-31](../packages/core/src/speech-synthesizer/SpeechSynthesizer.ts#L5);
   update `MockSpeechSynthesizer` and any fixtures.
2. **Per-adapter pronunciation handling (§2.1, §2.2).** Per-adapter
   helper (no core util, §5.3): Inworld inlines IPA on sync + rt (drop
   the silent-skip branch); OpenAI / Gemini / ElevenLabs (all methods)
   reject non-empty `pronunciations` with `Unsupported` and lose their
   `PHONEME_SUPPORTED_MODELS` / `applyPronunciations` code. Tests: assert
   `Unsupported` per provider, and that an IPA entry still renders on
   Inworld.
3. **Bucket-2 warns (§2.3).** `warnDroppedWhen` for Gemini `speed` +
   `languageCode`, OpenAI `languageCode`. (`instructions` stays silent,
   §2.4: no work.)
4. **Trim `DialogueTurn` (§2.5).** Drop `styleDescription` / `speed`
   from the Common type; update `MockSpeechSynthesizer` and the ElevenLabs
   dialogue codec (which already ignores them, so the diff is removals).

**Breaking changes:** (1) `CustomPronunciation` loses its `encoding`
field and `PhoneticEncoding` is removed; pronunciations are IPA-only.
(2) Passing `pronunciations` to a provider with no stateless IPA path
now fails with `Unsupported` instead of silently producing audio with
default pronunciation. Both are intended (one encoding; fail loud, never
ship wrong audio) and belong in the changeset.

---

## 5. Open decisions (all settled)

- **Keep the single service**, no `…Sync` / `…Realtime` / `DialogueTts`
  split (§1.3). Resolves capabilities §11 for TTS.
- **No `PronunciationGuarantee` marker** (§1.3). Bucket-1 runtime
  reject, not a compile-time gate.
- **Collapse `CustomPronunciation` to IPA only** (§2.1): drop the
  `encoding` enum, adapters convert IPA to X-SAMPA internally where the
  wire needs it, CMU Arpabet exits with the legacy models. Not branded
  (plain documented `string`).
- **Pronunciations fail the whole call if any entry is unrenderable**
  (§2.1), with the fallback tension consciously resolved in favor of
  loud failure (rationale in §2.1). This is the core call: correctness
  default over fallback ergonomics; fallback recovers at the recipe
  layer by catching outage-class errors only.
- **5.1 ElevenLabs inline IPA `pronunciations`: `Unsupported`** on all
  methods (§2.2); no legacy SSML, no inline-into-WS. **But** expose a
  `pronunciationDictionaryLocators` provider extra (sync + streaming +
  incremental) that references caller-provisioned dictionaries by ID.
  We never upload/provision dictionaries; that stays the caller's job.
- **5.2 OpenAI `instructions`: leave silent** (§2.4). No per-model warn.
- **5.3 Pronunciation helper: per-adapter local**, no core util (§2.1).
  The only shareable piece is the IPA-to-X-SAMPA table, worth extracting
  when a second X-SAMPA provider lands.
- **5.4 Trim `DialogueTurn.styleDescription` + `speed`** (§2.5). Remove
  the two Hume-only fields from Common now; reintroduce as a Hume-typed
  turn extension when that adapter lands. The main `CommonSynthesizeRequest`
  is otherwise clean (no trims).

---

## 6. Effort

| Item | Effort |
|---|---|
| Domain: collapse `CustomPronunciation` to IPA (§2.1) + mock | ~1 hour |
| Per-adapter pronunciation handling, all methods (§2.1, §2.2) + tests | ~half-day |
| ElevenLabs `pronunciationDictionaryLocators` provider extra (§2.2) | ~1 hour |
| Bucket-2 warns (§2.3) | ~1 hour |
| Trim `DialogueTurn` (§2.5) + mock/codec updates | ~30 min |
| Changeset / migration note (IPA collapse + breaking pronunciation behavior + `DialogueTurn` trim) | ~30 min |

Total: roughly one focused day. Far smaller than STT, because the TTS
surface, markers, narrowing, and `Duration` were already right: this is
a bucket-classification correctness pass, not a redesign.

Deferred (separate efforts, not now): the IPA-to-X-SAMPA conversion
table (only needed when an X-SAMPA-wire provider like Google / Azure
lands); Google Cloud TTS / Chirp 3 HD adapter
([chirp-stt.md](./chirp-stt.md) sibling for the STT side); per-turn
dialogue timing metadata (only Hume returns it).
