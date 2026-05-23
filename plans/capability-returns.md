# Return-shape design for capability degradation

A follow-on to [plans/capabilities.md](capabilities.md). That doc
debates _how_ a provider should signal that it can't honor a request
field — refuse (`AiError.Unsupported`), drop silently, drop with a
warning. This doc asks a more basic question:

> What does the **consumer** need to see in the result so they don't
> care about that debate?

The motivating case is multi-provider patterns (council, fallback)
where the current "refuse with `Unsupported`" answer makes
composition awkward — but the answer holds for single-provider code
too.

---

## 1. What the consumer actually writes

Whether a provider refuses or degrades, the consumer eventually
writes one of two patterns:

```ts
// (1) Inspect the output — render what's present
{result.words?.map((w) =>
  w.speakerId
    ? <Speaker id={w.speakerId} text={w.text} />
    : <Plain text={w.text} />
)}

// (2) Trust the request — assume what we asked for is there
{request.diarization
  ? result.words?.map((w) => <Speaker id={w.speakerId ?? "?"} text={w.text} />)
  : <Plain text={result.text} />}
```

Pattern (2) is **already broken** even on diarization-capable
providers:

- The audio has one speaker → diarizer returns one cluster (or no
  `speakerId` at all).
- A `partial` event arrived before the diarizer clustered the segment.
- The provider only emits `speakerId` on `final` events.
- The provider only diarizes when more than N seconds of audio are
  buffered.

Any consumer writing real UI code ends up in pattern (1) — they
inspect the output. The request flag is a _wish_, not a contract,
because the output shape was never going to honor it
unconditionally.

**Implication**: as long as the output is honest about what's there,
the provider doesn't need to refuse to keep the consumer correct.
Refusing forces an exception path on top of an inspection path the
consumer was already going to write.

---

## 2. Three return shapes

### Shape A — Current type, implicit truth

```ts
type TranscriptResult = {
  readonly text: string
  readonly languageCode?: string
  readonly durationSeconds?: number
  readonly words?: ReadonlyArray<WordTimestamp>
  readonly raw?: unknown
}

type WordTimestamp = {
  readonly text: string
  readonly startSeconds: number
  readonly endSeconds: number
  readonly speakerId?: string
  readonly confidence?: number
  readonly languageCode?: string
}
```

Truth is implicit in optional-field presence.

- **Pro:** minimal, what we ship today.
- **Con:** ambiguous between "provider didn't try" and "audio had
  nothing to label." The consumer can't distinguish "I asked for
  diarization, got nothing" from "I asked for diarization, got one
  speaker" — they look identical in `words[].speakerId`.

### Shape B — Echo back what was honored

```ts
type TranscriptResult = {
  readonly text: string
  readonly languageCode?: string
  readonly durationSeconds?: number
  readonly words?: ReadonlyArray<WordTimestamp>
  /**
   * What the provider actually honored. Booleans rather than
   * optionals because the answer is always known.
   */
  readonly applied: {
    readonly diarization: boolean
    readonly wordTimestamps: boolean
  }
  readonly raw?: unknown
}
```

Truth is explicit in the result. The consumer reads
`result.applied.diarization` to know "was this honored", not
`request.diarization` (the wish).

- **Pro:** zero ambiguity. Multi-provider routing (council, fallback)
  becomes a property check, not a heuristic. Observability is
  derivable: `request.X === true && applied.X === false` is a
  degradation event.
- **Con:** every new capability flag extends `applied` AND requires
  every adapter to populate it. Linear adapter friction.

### Shape C — Echo + degradation reasons

```ts
type TranscriptResult = {
  readonly text: string
  readonly languageCode?: string
  readonly durationSeconds?: number
  readonly words?: ReadonlyArray<WordTimestamp>
  readonly applied: { readonly diarization: boolean; readonly wordTimestamps: boolean }
  /** Asked for but not honored. */
  readonly degraded?: ReadonlyArray<{
    readonly capability: string
    readonly reason: string
  }>
  readonly raw?: unknown
}
```

Same as B plus a structured trace of _why_ each ask was dropped.

- **Pro:** audit-grade signal.
- **Con:** `degraded[]` is empty on the happy path; pure overhead for
  the common case.

---

## 3. Mapping shapes to consumer jobs

| Job                                                                                      | What they need                          | Best shape                       |
| ---------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------- |
| **Render a transcript** (chat UI, captions)                                              | The data, as-is. Render what's present. | A is sufficient                  |
| **Multi-provider council / fallback** ("did anyone diarize?")                            | A predicate per result.                 | B — `result.applied.diarization` |
| **Audit / debugging / billing** ("which asks did this provider honor across the batch?") | Per-call structured trace.              | C                                |

The render job dominates by volume. The audit job is rare. The
multi-provider job sits between, and is where Shape A's heuristics
break down.

### Why Shape A fails the multi-provider job

```ts
const [a, b, c] =
  yield *
  Effect.all([
    withLayer(ElevenLabs, transcribe(req)),
    withLayer(OpenAI, transcribe(req)),
    withLayer(Gemini, transcribe(req)),
  ])
const diarizedResult = [a, b, c].find(/* heuristic */) ?? a
```

`/* heuristic */` could be:

- `r.words?.some((w) => w.speakerId !== undefined)` — fires for
  single-speaker diarized audio too, doesn't distinguish provider
  capability from audio content.
- `r.words?.some((w, _, arr) => arr.some((other) => other.speakerId !== w.speakerId))` —
  needs ≥2 speakers in the audio to detect; doesn't fire on
  one-speaker audio where the provider _did_ try.

There's no Shape A predicate that cleanly answers "did the provider
attempt diarization?" Shape B answers it with `r.applied.diarization`.

### The reverse case Shape B also fixes

A caller _doesn't_ ask for diarization, but the provider always
diarizes (some Deepgram / Azure modes). With Shape A, the result
has `speakerId` populated and the consumer has no idea whether to
trust it or where it came from. With Shape B, `applied.diarization`
is `true` regardless of what the request said — the output is the
truth.

---

## 4. Recommendation

**Shape B.** A result every time (no `Unsupported` for capability
gaps on modifier flags), with an `applied` object that names what
the provider honored.

This collapses three problems at once:

1. **The "row D vs row E" debate** from [capabilities.md §4](capabilities.md)
   dissolves for modifier flags. Every degradable flag is row E by
   default; honesty lives in the output, not the error channel.

2. **Multi-provider scenarios** (council, fallback) become trivial.
   Every tier returns a result; the consumer ranks by
   `applied.*`. No exception handling for capability gaps, no
   tier-level request transformation, no special combinator
   behavior.

3. **Observability** becomes derivable. The proposed
   `CapabilityWarning` event from [capabilities.md §7](capabilities.md)
   can be emitted automatically from any
   `request[c] === true && applied[c] === false` mismatch — no
   manual `dropUnsupported` calls scattered through adapters.

`AiError.Unsupported` doesn't go away. It stays for **genuine
"no result possible" cases**:

- Image part on a text-only embedding provider (no embedding vector
  to return).
- Multi-part `content[]` on Jina (no wire shape to encode it as).

For those, the test is "**is a result of any shape possible?**" If
no → row D, `Unsupported`. If yes → row E, degrade with
`applied[*] === false`.

---

## 5. Where it goes in the type system

The `applied` field lives on the **result types**, not the request
types. Concretely:

```ts
// @effect-uai/core/Transcript
export type TranscribeApplied = {
  readonly diarization: boolean
  readonly wordTimestamps: boolean
  // ... add per capability
}

export type TranscriptResult = {
  readonly text: string
  readonly languageCode?: string
  readonly durationSeconds?: number
  readonly words?: ReadonlyArray<WordTimestamp>
  readonly applied: TranscribeApplied
  readonly raw?: unknown
}

// Mirror on final events:
export type TranscriptEvent =
  | { readonly _tag: "partial"; readonly text: string; ... }
  | {
      readonly _tag: "final"
      readonly text: string
      readonly words?: ReadonlyArray<WordTimestamp>
      readonly languageCode?: string
      readonly applied: TranscribeApplied
    }
  | ...
```

Same idea for the other service shapes:

- `AudioBlob` (TTS) — `applied: { pronunciations: boolean; instructions: boolean; ... }`
- `EmbeddingResult` — `applied: { task: boolean; ... }`
- `Turn` (LLM) — out of scope for now; LLM modifier flags are
  thinner and mostly already advisory.

The keys of `applied` are typed; a consumer gets autocompletion.
New capabilities extend the type, which forces every adapter to
populate the field — exactly the friction we want to surface the
fact that an adapter needs to be updated.

---

## 6. Per-provider population

What each adapter writes:

| Provider                       | `applied.diarization`      | `applied.wordTimestamps`        |
| ------------------------------ | -------------------------- | ------------------------------- |
| ElevenLabs Scribe              | `req.diarization === true` | `req.wordTimestamps === true`   |
| OpenAI Whisper-1               | `false` (never)            | `req.wordTimestamps === true`   |
| OpenAI GPT-4o-transcribe       | `false` (never)            | `false` (model doesn't support) |
| Gemini (`generateContent` STT) | `false` (never)            | `false` (never)                 |
| Google Cloud STT (Chirp 2)     | `req.diarization === true` | `req.wordTimestamps === true`   |
| AssemblyAI Universal-2         | `req.diarization === true` | `req.wordTimestamps === true`   |
| Deepgram Nova-3                | `req.diarization === true` | `req.wordTimestamps === true`   |

Mechanical. Three lines per adapter for two flags. The OpenAI model
× field interaction at the request level still exists internally
(do we ask the wire for `verbose_json` to get word timing?), but the
_output-side_ claim is whether the response carries the data.

---

## 7. Caller-side strictness

The "I _require_ diarization" caller still has a clean idiom:

```ts
const result = yield * Transcriber.transcribe(req)
if (req.diarization && !result.applied.diarization) {
  yield * Effect.fail(new MyDomainError("diarization required"))
}
```

Domain-specific failure carries the domain-specific reason —
better than catching a provider-level `Unsupported` and translating
it. The provider never had domain knowledge of why diarization was
required.

A future utility could collapse this:

```ts
// pseudocode — not yet designed
Transcriber.transcribe(req).pipe(
  Transcriber.requireApplied(["diarization"], (missing) => new MyDomainError(...))
)
```

But not necessary on day one.

---

## 8. Implications for [capabilities.md](capabilities.md)

If we adopt Shape B:

1. **§4.2 matrix** — replace the row D/E test with:
   > **Is a result of any shape possible?** If yes → row E
   > (degrade, populate `applied[c] === false`). If no → row D
   > (`Unsupported`, no result at all).
2. **§9.3 runtime guards** — the `ensureSupported` /
   `guardGenericCapabilities` Functions I added in the generic
   `Transcriber` Layer adapters
   ([GeminiTranscriber.ts:200-204](packages/providers/google/src/GeminiTranscriber.ts#L200-L204),
   [OpenAITranscriber.ts:260-262](packages/providers/openai/src/OpenAITranscriber.ts#L260-L262))
   should be deleted. The adapters degrade silently and report via
   `applied`. The type-level narrowing (Omit on the typed request)
   stays.
3. **§9.1 pronunciations** — move from row D to row E. The audio
   still renders; `applied.pronunciations` reports honesty.
4. **§9.2** stays D — image-on-text-embedding and
   multi-part-on-Jina have no shape to degrade into.
5. **§7 `CapabilityWarning`** — implementation becomes
   "automatically emit on `req.X && !applied.X` mismatch at the
   service boundary," not "adapter calls `dropUnsupported()`."

---

## 9. Open questions

- **`applied` for fields the request didn't set.** If `req.diarization`
  is `undefined` and the provider always diarizes, should
  `applied.diarization` be `true`? Probably yes — it reports the
  _output_ state, not the _match_ between request and output. The
  consumer checks `applied`, not `request`.
- **Streaming events.** `applied` on `final` events is clear. On
  `partial`s — does it report what the partial honors, or the
  current state of the in-progress diarizer? Probably the former
  (per-event truth, may flip from `false` to `true` as the diarizer
  catches up).
- **TTS `pronunciations`.** Could split into
  `applied.pronunciations: ReadonlyArray<{phrase: string; honored: boolean}>`
  rather than a single boolean — finer-grained, but heavier shape.
  Probably not worth it day one.
- **Schema migration.** This is breaking for `TranscriptResult` /
  `AudioBlob` / `EmbeddingResult`. 0.6.0 hasn't shipped — we can
  fold it in without a breaking changelog entry, same as the
  `DialogueTurn` reshape.

---

## 10. Decision checkpoint

Adopt Shape B for transcription, TTS, embeddings. Revisit
streaming events once the result-level pattern lands. Defer the
`requireApplied` combinator until someone needs it.

Roughly the work needed:

1. Add `applied: TranscribeApplied` to `TranscriptResult` and `final` event.
2. Add equivalent to `AudioBlob` and `EmbeddingResult`.
3. Populate from every adapter (~10 sites).
4. Remove the §9.3 runtime guards from the generic adapters.
5. Update `capabilities.md §4` matrix language.
6. Update the §9 violation list against the new matrix.
