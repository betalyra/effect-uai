# Documentation structure

Status: design plan, partial implementation.

This plan captures how the docs site will grow as `effect-uai` adds
model types beyond language models. The shape we land on for embeddings
is the template for every capability that follows.

## Why this matters now

Today the sidebar groups by _artifact_ (Concepts / Providers / Recipes)
and every artifact silently assumes "language model". That works while
there is one capability. It stops working the moment we add a second
one — embeddings, rerank, speech, realtime audio, image / video /
music generation are all under active or planned consideration.

We can either bolt each new capability onto the existing structure as
it lands, or fix the structure once with the future in mind. This plan
does the second.

## What we're building toward

```
Start here          Why · Installation · Quickstart · Basic usage ·
                    Structured output · Basic embedding · Skills

Concepts            Cross-cutting only:
                    layers, items, errors, media domain, vector math

Language models     Concept · Recipes · Providers' specifics
Embeddings          Concept · Multimodal · Multivector · Providers' specifics
Reranking           (coming soon)
Speech              STT · TTS (coming soon)
Realtime audio      (coming soon)
Image generation    (coming soon)
Video generation    (coming soon)
Music generation    (coming soon)

Provider setup      One small page per provider: config, auth, baseUrl.
                    Linked from every capability page.
```

Reasoning:

- **Capability-first.** Users think "I need TTS" before "with which
  provider". Today's per-provider pages assume language model and break
  down the moment a provider participates in two capabilities. OpenAI
  alone covers language, embedding, STT, TTS, image, and realtime;
  Google covers most of the same plus video. A capability-first sidebar
  scales; a provider-first one becomes a matrix.
- **Concepts stays narrow.** Cross-cutting primitives (layer wiring,
  item history, the media domain, vector math, error taxonomy) live
  here. Per-capability concepts live under their own section so the
  whole story for one capability is co-located.
- **Provider setup deduped.** Each provider has one small page with
  config, auth, and baseUrl. Capability pages link to it instead of
  repeating wire-up. Keeps capability pages focused on shape and
  per-provider quirks.
- **Coming-soon stubs.** Capabilities we don't yet support get a stub
  page so users can find them, see they're on the radar, and signal
  interest. Cheap to add, valuable for prioritisation.

## The hidden taxonomy: interaction archetypes

The capability axis is what users navigate by. The archetype axis is
what the abstractions are built around. There are roughly four:

| Archetype                | Service shape                 | Capabilities                                          |
| ------------------------ | ----------------------------- | ----------------------------------------------------- |
| **One-shot**             | `Effect<Response, Err, Svc>`  | embed, rerank, image gen, OCR, simple TTS, simple STT |
| **Streaming output**     | `Stream<Delta, Err, Svc>`     | streaming TTS, streaming STT, simple chat             |
| **Turn-based**           | `history → Stream<TurnEvent>` | language model with tools                             |
| **Bidirectional duplex** | input stream + output stream  | realtime audio (OpenAI Realtime, Gemini Live)         |
| **Async job**            | `submit → poll/subscribe`     | video gen, sometimes music gen                        |

The first three sit comfortably on Effect / Stream / the existing loop
primitive. The last two need new primitives — duplex (a `Channel` or
`Queue<In>` + `Stream<Out>` pair) and async-job (poll-or-subscribe).
Design those when the first realtime / video provider is on the table,
not now.

## Capability inventory

Live or in flight:

- **Language models** — turn-based with tools. Shipped.
- **Embeddings** — one-shot, text + image, dense / sparse /
  multivector. Shipped (Google, OpenAI, Jina).

Planned, in roughly likely-build order:

- **Reranking** — one-shot, query + docs → relevance scores. Closest
  next neighbour to embeddings; same providers (Cohere, Jina, Voyage,
  Mixedbread). Plan exists at `plans/embeddings.md` (rerank section).
- **Speech (STT + TTS)** — one-shot or streaming, audio ↔ text. Paired
  in workflows so they share a section. Likely providers: OpenAI
  (Whisper / `tts-1` / `gpt-4o-transcribe`), ElevenLabs, Deepgram,
  Google.
- **Realtime audio** — bidirectional duplex, voice agents. Different
  archetype (full duplex), needs its own primitive. Likely providers:
  OpenAI Realtime, Gemini Live.
- **Image generation** — one-shot text → image, image edit, inpainting.
  Likely providers: OpenAI (`gpt-image-1`), Google Imagen, Black Forest
  Labs (Flux), Stability.
- **Video generation** — async job, prompt → video. Likely providers:
  Google Veo, OpenAI Sora, Runway.
- **Music generation** — async-ish, prompt → audio. Likely providers:
  Suno, Udio, Google MusicLM.

Folded in or excluded:

- **OCR / document understanding** increasingly lives inside vision
  language models. Standalone OCR providers (Mistral OCR) might warrant
  their own capability later if the workflow shape diverges.
- **Translation** is a language-model task; no separate capability.
- **Voice cloning** is a TTS variant — likely a request flag inside
  the speech capability, not its own section.
- **Object detection / segmentation / pose** — specialty vision; defer
  unless a clear provider story emerges.
- **Image / video capture** is a runtime concern (camera, screen).
  Not a model abstraction. Producers of `MediaSource` values, no more.

## File layout

The Astro Starlight site loads from `docs/**/*.{md,mdx}` plus
`recipes/*/README.md`. The capability-first structure maps to:

```
docs/
  index.mdx                       Hero / landing
  start/
    why.md
    installation.md
    getting-started.md
  concepts/
    items-and-turns.md
    loop.md
    tools.md
    errors.md                     (planned, lifts AiError out of provider pages)
    media.md                      (planned, MediaSource / Image / Audio / Video)
    vectors.md                    (planned, Vector.* primitives)
  language-models/                (renamed from concepts/language-model.md;
                                   absorbs current providers/* and recipes/* that
                                   apply to language models)
    index.md                      Concept (was concepts/language-model.md)
    providers/
      responses.md
      gemini.md
      anthropic.md
    recipes/                      (linked from existing recipes/*/README.md;
                                   no need to relocate the source READMEs)
  embeddings/
    index.md                      Concept
    multimodal.md                 Cross-modal scenario
    multivector.md                Late-interaction scenario
    providers/
      responses.md                OpenAI text-only embedding specifics
      gemini.md                   Multimodal + task-type specifics
      jina.md                     Sparse + multivector specifics
  reranking/
    index.md                      Coming soon stub
  speech/
    index.md                      Coming soon stub
  realtime-audio/
    index.md                      Coming soon stub
  image-generation/
    index.md                      Coming soon stub
  video-generation/
    index.md                      Coming soon stub
  music-generation/
    index.md                      Coming soon stub
  providers/                      (transitional: today's per-provider pages;
                                   contents migrate into capability sections
                                   over time)

recipes/
  <name>/
    index.ts                      Runnable code
    README.md                     Loaded as recipe page when applicable
                                   (kept for language-model recipes; embedding
                                   scenarios live in docs/embeddings/* instead)
```

Recipe folders for embedding scenarios contain runnable code only —
their docs live under `docs/embeddings/`. The recipe README pattern
made sense when every recipe was a loop variant; embedding scenarios
are use-mode demos, not loop patterns, and don't need the README-as-doc
shortcut.

## Migration in stages

Don't restructure all at once. The current "Concepts / Providers /
Recipes" sidebar still works; collapse it into capability-first as
each new capability lands.

**Stage 0 — done.** Plan doc, six coming-soon stubs, and a sidebar
restructure that groups existing language-model content under a
`Language models` capability section (with sub-groups for `Providers`
and `Recipes`). `Concepts` shrunk to cross-cutting only — currently
holds `Items and turns`; the rest (loop, tools, language-model
overview) moved under `Language models`. Files were not relocated;
slugs and cross-references keep working as-is.

**Stage 1 — embedding section (next).** Write the embedding concept
page, multimodal page, multivector page, basic-embedding recipe
README (linked from Start here). Extend each provider page with an
embedding section, or split off provider-specific embedding pages
under `Embeddings › Providers`. Sidebar gains an `Embeddings`
top-level group, slotted between `Language models` and `Coming soon`.

**Stage 2 — file relocation (optional, when convenient).** Move
`docs/concepts/language-model.md` → `docs/language-models/index.md`,
`docs/concepts/loop.md` → `docs/language-models/loop.md`, etc., so
URLs match section. Adds redirects for old paths. Defer until a
second capability is in the sidebar and the inconsistency starts to
hurt — sidebar grouping alone is enough for now.

**Stage 3 — provider setup pages.** When the first provider
participates in three or more capabilities, extract a `Provider setup`
group with one page per provider for config / auth / baseUrl, and have
capability pages link to it instead of repeating wire-up.

**Stage 4 — duplex / async-job primitives.** When the first realtime
or video provider lands, design those archetypes' core primitives, add
a `Concepts` page each, and the corresponding capability sections
become real instead of stubs.

## Writing style guardrails

The voice we want, derived from existing `docs/`:

- **Open with the user-facing problem or framing**, not the API
  surface. Examples on file: "An agent is a loop over your state.",
  "Provider choice should be wiring, not program structure."
- **Speak to "you"**, not "the user". Imperative when natural.
- **Short paragraphs, tight prose.** Two or three sentences each, no
  bloat.
- **Code samples are small and shape-revealing**, not realistic. They
  exist to show how the pieces fit, not to be production templates.
- **End sections with a `Next step` or `See also`** that links forward.
- **Bold key phrases** for scannability ("**Not an abstraction over
  response shape.**").
- **Honest about scope** — pages often have a "What this is not" list.
- **Tables for structured info** (error mapping, archetype to
  capability, etc.).
- **Run-it sections** with a `pnpm tsx <path>` line and a link to the
  source on GitHub.

What to avoid:

- Leading with the type signature. The signature comes after the
  motivation.
- Restating the API in prose. If a code block already shows the shape,
  the surrounding prose explains _why_, not _what_.
- Marketing tone. The voice is editorial — declarative, opinionated,
  occasionally dry.

## Open questions

- Where does `Vector` math live in the sidebar? Two options: under
  `Concepts` (cross-cutting math primitive) or under `Embeddings`
  (the only consumer today). Defaulting to Concepts when written —
  rerank will also use it.
- Single `Speech` section, or split `Speech-to-text` and
  `Text-to-speech`? Pairing them keeps related providers and shared
  audio domain types in one place; splitting matches "one capability,
  one section". Lean toward pairing under `Speech` with sub-pages.
- Does `Provider setup` deserve a dedicated top-level group from day
  one, or only once the matrix gets dense? Currently deferred to
  stage 3.
