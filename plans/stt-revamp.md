# Plan: Transcriber (STT) capabilities revamp

Companions: [capabilities.md](./capabilities.md) (the guideline) ·
[capabilities-plan.md](./capabilities-plan.md) (**this supersedes its
Phase 2**) · [music-revamp.md](./music-revamp.md) (sibling, same
method) · [stt-tts-wire.md](./stt-tts-wire.md) (wire shapes, 2026-05-11;
§3 is grounded in it + a June 2026 web check).

STT now has **3 providers / 6 Layers** in tree: OpenAI (sync+rt),
ElevenLabs (sync+rt one Layer), Inworld (sync+rt). Two decisions from
the prior discussion carry in: Phase 0 already landed as `warnDropped`
in
[capabilities/Capabilities.ts](../packages/core/src/capabilities/Capabilities.ts),
and **the `fallback` combinator is dropped** (see §1.3).

> **Update — Gemini STT removed.** The `@effect-uai/google`
> `GeminiTranscriber` rode on `:generateContent` (an LLM with a
> hardcoded "transcribe" prompt) — a category error, not a
> transcription API. It was **deleted entirely** (source, test,
> `GeminiSttModel`, the `index`/`package.json` export, and the
> `--provider gemini` recipe path). The real Google STT is **Cloud
> Speech-to-Text V2 / Chirp 3**, planned separately in
> [chirp-stt.md](./chirp-stt.md) (deferred). **Consequence:** the
> Gemini-specific Phase-1 narrowing items below (the `Omit`, the guard
> deletion, the matrix column, the prompt-embed warn) are **obsolete** —
> OpenAI is the only Phase-1 narrowing that stands.

---

## 1. Current state

### 1.1 Right, keep as-is

- One service, two methods; `SttStreaming` service-level marker gates
  `streamTranscriptionFrom` (sync-only Layers omit it).
  [Transcriber.ts:39-82](../packages/core/src/transcriber/Transcriber.ts#L39).
- `model` already narrowed on every provider request
  (`Omit<…,"model"> & { model: <Union> }`) — §3.4 work done.
- Results lax: `words`/`speakerId`/`languageCode` optional. Markers are
  GATE-ONLY (Appendix A) → **no result-type narrowing.**
  [Transcript.ts](../packages/core/src/domain/Transcript.ts).
- `inputFormat` streaming reject = bucket-1 `Unsupported`, correct on
  all 3 realtime adapters. Inworld URL-audio reject stays
  `InvalidRequest` (genuine §3.5 wire-shape).

### 1.2 What changes (and what was reconsidered)

- **`prompt: string | { terms }` → split into two fields (DONE).**
  `prompt?: string` (free-form prose, Whisper-style) and
  `biasingTerms?: ReadonlyArray<string>` (discrete vocab biasing). They
  are **orthogonal mechanisms** — a union modeled them as mutually
  exclusive, which is wrong in principle (a provider could honor both).
  The split also enforces the no-prompt-building rule: each field maps
  to a _structured_ wire field or `warnDropped`, no `typeof` branching,
  no stuffing terms into a prose field. Mapping: `prompt` → OpenAI
  `prompt` (others warn); `biasingTerms` → ElevenLabs `keyterms`,
  Deepgram `keyterm`, Google `adaptation`, Inworld `prompts` (OpenAI
  warns). (This reverses the earlier "keep the union" call — the wire
  doc's union recommendation was a roster coincidence, not a reason to
  fuse orthogonal capabilities.)
- **`interimResults` — keep.** Zero in-tree honorers (all 3 adapters
  emit partials unconditionally), but a wire home on ≥4 providers
  incl. Inworld rt's `transcribe_config`
  ([:1386](./stt-tts-wire.md#L1386)). Forward-looking; wire where the
  field exists, `warnDropped` where partials can't be suppressed.
- **Inworld is an aggregator** (routes to AssemblyAI/Soniox/Groq via
  `modelId`, [:1426](./stt-tts-wire.md#L1426)). Per capabilities §5/§10
  → `Service` + `SttStreaming` only, **no per-modifier markers, no
  proactive guards.** Its silent `diarization` pass-through is correct
  lax behavior, not a violation. (Earlier draft wrongly flagged it.)
- **Don't error on `diarization`/`wordTimestamps`.** They're GATE-ONLY
  (Appendix A) — the result fields are optional because their presence
  varies, so a non-supporting provider on the lax path returns them
  **absent**, not `Unsupported`. The marker is the compile-time
  guarantee (§2.3); the runtime mustn't duplicate it. The current
  OpenAI/Gemini proactive guards are **removed** (§2.1); the only
  `Unsupported` is a provider's own rejection, translated (§2.2).
- **Diarization is per-method on ElevenLabs** — `diarize` on
  batch/sync only; realtime model deliberately doesn't (confirmed June
  2026). One Layer, two methods, one per-Layer marker → §5 decision.
- **`durationSeconds: number` → `duration?: Duration.Duration`** on
  `TranscriptResult`, matching [music-revamp §2.2](./music-revamp.md).
  Word `startSeconds`/`endSeconds` stay `number` (offsets, per
  `MusicSection` precedent).

### 1.3 `fallback` combinator — removed

The capabilities-plan Phase 2 `Transcriber.fallback` (tier list,
per-call `orElse`, marker intersection via `IntersectROut`) is **not
built.** Falling through on `AiError.Unsupported` re-introduces silent
cross-provider degradation (§2.2 / §10 "the lie"); the intersection
machinery was a band-aid with fragile type recursion. Provider failover
is a recipe (`Effect.catchTag` on `RateLimited`/`Unavailable`/`Timeout`
only — the existing `effect-uai-multi-model-fallback` pattern). Phase 2
is **markers + `requireX` only.**

---

## 2. Changes

### 2.1 Narrowing + drop the proactive guards (§14.3, refined)

`diarization` / `wordTimestamps` are GATE-ONLY (Appendix A): the result
fields are optional _because their presence varies_ (single-speaker
audio → no `speakerId`; empty utterance → no `words`). So a
non-supporting provider on the lax path should return the field
**absent**, not error — that's the documented "providers ignore what
they don't support" contract. The compile-time guarantee is the
**marker** (§2.3); the runtime should not duplicate it as a proactive
`Unsupported`. (This refines capabilities §14.3, which over-eagerly
kept the guards.)

So per provider:

- **Gemini**: `Omit<…,"model"|"wordTimestamps"|"diarization">` (typed
  surface), **delete** the proactive `ensureSupported` rejections
  ([:48-65](../packages/providers/google/src/GeminiTranscriber.ts#L48)) —
  Gemini just transcribes and returns text with no `speakerId`/`words`.
  Omit both markers.
- **OpenAI**: `Omit<…,"model"|"diarization">`; **keep `wordTimestamps`**
  (works on whisper-1); **delete** the proactive `diarization` guard
  ([:92-100](../packages/providers/openai/src/OpenAITranscriber.ts#L92)).
- **Inworld**: no change (aggregator).

The earlier "re-type the guard to the wide request" step is gone —
there's no proactive guard to keep, so the
`GeminiTranscribeRequest`-vs-`CommonTranscribeRequest` contradiction
dissolves.

**Result-type narrowing stays deferred.** Markers gate the call only;
they don't narrow `speakerId`/`words` to non-optional. The NARROW
technique (Appendix A) is future work, if ever.

### 2.2 Drop the per-model check; the 400 stays `InvalidRequest` (§14.4)

Drop the `wordTimestamps && model !== "whisper-1"` proactive check
(removed with `guardCapabilities`); keep the `wordTimestamps` field.
A non-whisper-1 model now rejects `verbose_json` at the wire, surfacing
as the generic 400 → `httpStatusError` → **`InvalidRequest`**.

We deliberately **don't** reclassify that 400 to `Unsupported`:
distinguishing the capability 400 from an unrelated 400 means inspecting
OpenAI's error envelope (`error.param`), which is fragile and was judged
not worth it. (Strictly, §3.5 wants capability gaps as `Unsupported`,
not `InvalidRequest` — this is a conscious deviation favoring simple
code. Revisit if a consumer needs to pattern-match it.) Gemini doesn't
400 on these → stays lax-silent (§2.1).

### 2.3 Per-modifier markers (§6, §7 Tier 2)

`DiarizationGuarantee` + `WordTimestampsGuarantee`, co-located in
`Transcriber.ts` with `@experimental` JSDoc, plus dual Effect/Stream
`requireX` combinators (single `as any` at the impl boundary, same
shape as the music plan's pattern). No result-type narrowing.

Registration (verified inventory + aggregator rule):

| Layer             | `SttStreaming` | `Diarization`  | `WordTimestamps`               |
| ----------------- | -------------- | -------------- | ------------------------------ |
| OpenAI sync / rt  | ✗ / ✓          | ✗              | ✗ (whisper-1 only / not wired) |
| ElevenLabs        | ✓              | ⚠ §5.3         | ✓                              |
| Inworld sync / rt | ✗ / ✓          | ✗ (aggregator) | ✗ (aggregator)                 |

**Thin in-tree rollout:** only ElevenLabs ships these. Clears the §7
bar (ships vs OpenAI doesn't) but real discrimination arrives with
**Google Cloud STT (Chirp 3)** / **Deepgram** (§3.2 / [chirp-stt.md](./chirp-stt.md)). Land
now vs defer → §5.4. OpenAI `withModel<M>()` escape hatch deferred.

### 2.4 `biasingTerms` / `prompt` wiring (DONE)

After the §1.2 split, each adapter maps the two fields independently —
to a structured wire field or `warnDropped`. Verified against provider
docs/SDK (ElevenLabs `keyterms` encoding confirmed from the SDK source:
repeated form fields, not JSON).

| Provider             | `biasingTerms`                               | `prompt`         |
| -------------------- | -------------------------------------------- | ---------------- |
| OpenAI (sync+rt)     | warn (no keyterm field)                      | → `prompt` field |
| ElevenLabs (sync+rt) | → `keyterms` (repeated; ≤1000 sync / ≤50 rt) | warn             |
| Inworld (sync+rt)    | → `prompts`                                  | warn             |

`warnDropped` via `warnDroppedWhen` from
[capabilities/Capabilities.ts](../packages/core/src/capabilities/Capabilities.ts).
(Gemini's prompt-embed warn is gone — its transcriber was removed.)

### 2.5 `Duration` migration (DONE)

`TranscriptResult.durationSeconds: number → duration?: Duration.Duration`,
matching `AudioBlob.duration` (already migrated by the music revamp) and
`Music`/`AiError`. OpenAI's verbose `duration` wraps via
`Duration.seconds(n)`. `WordTimestamp.startSeconds`/`endSeconds` stay raw
`number` offsets (positions, not durations). No `AudioBlob` setters used
`durationSeconds`, so the change was isolated to Transcript + the OpenAI
setter + tests.

---

## 3. Cross-provider matrix

### 3.1 In-tree (current adapter behavior)

S structured · P prompt-embedded · — unsupported/not-wired · M per-model

|                  | OpenAI sync     | OpenAI rt | ElevenLabs   | Inworld sync | Inworld rt  |
| ---------------- | --------------- | --------- | ------------ | ------------ | ----------- |
| `language`       | S               | S         | S            | S            | S           |
| `prompt` (prose) | S               | S         | warn         | warn         | warn        |
| `biasingTerms`   | warn            | warn      | S `keyterms` | S `prompts`  | S `prompts` |
| `diarization`    | —               | —         | S sync       | —            | —           |
| `wordTimestamps` | S (M whisper-1) | —         | S            | S            | S           |
| streaming        | —               | S         | S            | —            | S           |
| `interimResults` | —               | —         | —            | —            | —           |

(Reflects the post-change adapters: the `prompt`/`biasingTerms` split is
wired, and the OpenAI/Gemini proactive `diarization`/`wordTimestamps`
guards are gone — lax-silent absence on the generic surface.)

### 3.2 Expansion providers (verified, [stt-tts-wire.md](./stt-tts-wire.md) + web)

E = structured field present · × = unsupported

|                  | Google Cloud STT | Deepgram    | AWS Transcribe     | Cartesia | Azure    |
| ---------------- | ---------------- | ----------- | ------------------ | -------- | -------- |
| `diarization`    | E                | E           | E                  | ×        | ×        |
| `wordTimestamps` | E                | always      | always             | E        | E        |
| `biasingTerms`   | E `phraseSets`   | E `keyterm` | E `vocabularyName` | ×        | ×        |
| `interimResults` | E                | E           | E                  | always   | n/a      |
| streaming        | gRPC             | WS          | HTTP2/WS           | WS       | SDK-only |

Google Cloud STT and Deepgram are the real marker shippers (both
diarize + word-timestamp natively, per-Layer). Both have structured
`biasingTerms` fields and `interimResults` gating. AWS has no sync endpoint;
Azure streaming is SDK-only — both reduced-method Layers, neither blocks
this plan.

---

## 4. Sequencing

1. **Narrowing — done.** OpenAI `Omit diarization`, deleted the
   proactive `diarization`/`wordTimestamps` guards (lax-silent), dropped
   the per-model check (400 → `InvalidRequest`) (§2.1, §2.2). Gemini STT
   removed entirely (banner). Inworld untouched.
2. **Markers — postponed.** Additive to the `R` channel and result-type
   narrowing is out of scope, so they can land anytime later without
   disturbing anything. (Was Phase 2; see §2.3 / §5 for the deferred
   design.)
3. **`biasingTerms`/`prompt` split + wiring — DONE.** Common split into
   `prompt?: string` + `biasingTerms?: ReadonlyArray<string>`; all three
   providers wired per §2.4.
4. **Duration migration — DONE** (§2.5). Optional leftover: wire Inworld
   rt `interimResults`.

Breaking Common-shape change: `prompt: string | { terms }` →
`prompt?: string` + `biasingTerms?`. Plus the `durationSeconds →
duration` result-type change (Phase 4).

---

## 5. Open decisions

Settled: **(5.1) split `prompt` / `biasingTerms`** (done, §1.2/§2.4 —
reversed the "keep the union" call), **(5.2) keep `interimResults`**.

Need your call:

3. **ElevenLabs diarization asymmetry** — sync diarizes, realtime
   doesn't, one Layer. (a) ship `DiarizationGuarantee` (gates the
   strict path, ~always used with sync `transcribe`), document the
   realtime gap; (b) omit, stay lax, pending a per-method marker split
   (capabilities §11). _Rec: (a)_ — blocking on the divergent method is
   pessimism misfiring across methods rather than models.
4. **Land markers now or defer?** Only ElevenLabs ships in-tree (thin).
   (a) now — proves the mechanism, ElevenLabs `WordTimestamps` is clean,
   Cloud STT/Deepgram fill it later; (b) defer markers, do narrowing +
   keyterms + Duration first. _Rec: (a)_ — §7 commits to these as the
   first per-modifier markers.

---

## 6. Effort

| Phase                                  | Effort               |
| -------------------------------------- | -------------------- |
| 1 — narrowing (OpenAI) + tests         | ✅ done              |
| Gemini STT removal + chirp-stt.md plan | ✅ done              |
| `prompt`/`biasingTerms` split + wiring | ✅ done              |
| Duration migration                     | ✅ done              |
| 2 — markers                            | postponed (additive) |

Remaining: optional Inworld-rt `interimResults` wiring. (Chirp 3 / Cloud
STT adapter is a separate effort — [chirp-stt.md](./chirp-stt.md).)
