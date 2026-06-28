# Docs layout: a "browse by provider" view

## The problem

The docs are organized **by use case**. Each capability (Language models,
Embeddings, Speech, Music, Web search, Sandboxes) has its own sidebar
section with a `Providers` subsection inside it. This is good: a reader who
knows "I need speech" lands in one place and sees every backend that does
speech, with usage for each.

What is missing is the **orthogonal view**: "I already use Mistral (or
OpenAI, or Google) elsewhere. What can effect-uai do with it?" Today that
answer is scattered. Mistral appears under Language models _and_ under
Speech; Google appears under four different sections (LLM, Embeddings,
Speech, Music). Nothing shows that cross-cutting story in one place. ai-sdk
solves this with a dedicated Providers section.

Two constraints pull against just adding that section:

1. **No content duplication.** The per-use-case provider pages are the
   canonical, detailed source. A provider hub must not restate them.
2. **The sidebar is already large.** It has 9 top-level groups; several use
   cases nest `Providers` + `Recipes` subtrees. Adding one page per
   provider brand (there are ~10) would roughly double the visible surface.

## The provider landscape (why this is worth doing)

Twelve provider packages span six capabilities. The brands that cross more
than one capability are exactly the ones that benefit from a hub:

| Provider     | Package                                       | LLM | Embeddings | Speech | Music | Search | Sandbox |
| ------------ | --------------------------------------------- | :-: | :--------: | :----: | :---: | :----: | :-----: |
| OpenAI       | `@effect-uai/openai`, `@effect-uai/responses` |  +  |     +      |   +    |       |        |         |
| Google       | `@effect-uai/google`                          |  +  |     +      |   +    |   +   |        |         |
| Anthropic    | `@effect-uai/anthropic`                       |  +  |            |        |       |        |         |
| Mistral      | `@effect-uai/mistral`                         |  +  |            |   +    |       |        |         |
| ElevenLabs   | `@effect-uai/elevenlabs`                      |     |            |   +    |   +   |        |         |
| Jina         | `@effect-uai/jina`                            |     |     +      |        |       |        |         |
| Inworld      | `@effect-uai/inworld`                         |     |            |   +    |       |        |         |
| Exa          | `@effect-uai/exa`                             |     |            |        |       |   +    |         |
| Perplexity   | `@effect-uai/perplexity`                      |     |            |        |       |   +    |         |
| Tavily       | `@effect-uai/tavily`                          |     |            |        |       |   +    |         |
| Microsandbox | `@effect-uai/microsandbox`                    |     |            |        |       |        |    +    |
| Deno         | `@effect-uai/deno`                            |     |            |        |       |        |    +    |

Four brands (OpenAI, Google, Mistral, ElevenLabs) are multi-capability.
That is the cross-cutting story the current layout hides.

## Recommendation: one Providers overview page, zero new per-provider pages

Add a **single** top-level sidebar entry, `Providers`, that links to one new
page: a capability matrix plus a short card per provider. Every cell and
every card link points **into the existing per-use-case docs**. The page
holds no usage content of its own, only a one-line positioning sentence and
the install line per provider, both of which are cheap to keep accurate.

Why this shape:

- **+1 sidebar line, not +10.** A standalone link, not a nested group. The
  sidebar grows by one row.
- **Single source of truth.** All "how to use X for Y" prose stays in the
  use-case provider pages. The hub is a router, so it cannot drift into a
  second, stale copy.
- **Serves the browse-by-provider need directly.** A reader scans the matrix
  by row (provider) instead of by column (use case), then clicks straight to
  the detailed page.
- **Coherent URL.** The LLM provider pages already live at
  `/providers/<name>/`. Putting the hub at `/providers/` makes it the natural
  parent index of that namespace.

The page's own auto-generated table of contents (Starlight renders one from
the `##` headings on the right) gives a per-provider jump list without adding
any sidebar entries.

### Sidebar change (one line)

Insert a standalone link between `Start here` and `Concepts`:

```js
{ label: "Providers", slug: "providers" },
```

No `items`, no `collapsed`. It renders as a single clickable row. The LLM
provider pages keep their current home under the `Language models` group;
the hub does not move them, it links to them.

> Note: `slug: "providers"` needs an index at `docs/providers/index.md`.
> That path currently holds only the LLM provider leaf pages
> (`responses.md`, `gemini.md`, `anthropic.md`, `mistral.md`), so adding an
> `index.md` there is purely additive.

## The page (markdown mockup)

```md
---
title: Providers
description: Every backend effect-uai speaks to, and which capabilities each one covers. Browse by provider, then jump to the usage page for the capability you need.
---

effect-uai groups its docs by **capability**: language models, embeddings,
speech, and so on. This page is the other axis. If you already run a
provider elsewhere and want to know what effect-uai can do with it, find the
row and follow the link to the usage page.

Provider choice is always a Layer. Every provider registers under both its
own typed tag and the generic capability tag, so code written against the
generic tag is portable. See any capability overview for that seam.

## Capability matrix

| Provider         |            LLM             |              Embeddings               |               Speech               |                    Music                     |  Web search   |                 Sandbox                 |
| ---------------- | :------------------------: | :-----------------------------------: | :--------------------------------: | :------------------------------------------: | :-----------: | :-------------------------------------: |
| **OpenAI**       | [✓](/providers/responses/) | [✓](/embeddings/providers/responses/) |   [✓](/speech/providers/openai/)   |                                              |               |                                         |
| **Google**       |  [✓](/providers/gemini/)   |  [✓](/embeddings/providers/gemini/)   |   [✓](/speech/providers/gemini/)   |   [✓](/music-generation/providers/gemini/)   |               |                                         |
| **Anthropic**    | [✓](/providers/anthropic/) |                                       |                                    |                                              |               |                                         |
| **Mistral**      |  [✓](/providers/mistral/)  |                                       |  [✓](/speech/providers/mistral/)   |                                              |               |                                         |
| **ElevenLabs**   |                            |                                       | [✓](/speech/providers/elevenlabs/) | [✓](/music-generation/providers/elevenlabs/) |               |                                         |
| **Jina**         |                            |   [✓](/embeddings/providers/jina/)    |                                    |                                              |               |                                         |
| **Inworld**      |                            |                                       |  [✓](/speech/providers/inworld/)   |                                              |               |                                         |
| **Exa**          |                            |                                       |                                    |                                              | [✓](/search/) |                                         |
| **Perplexity**   |                            |                                       |                                    |                                              | [✓](/search/) |                                         |
| **Tavily**       |                            |                                       |                                    |                                              | [✓](/search/) |                                         |
| **Microsandbox** |                            |                                       |                                    |                                              |               | [✓](/sandboxes/providers/microsandbox/) |
| **Deno**         |                            |                                       |                                    |                                              |               |     [✓](/sandboxes/providers/deno/)     |

A ✓ links to the usage page for that provider and capability.

## OpenAI

`@effect-uai/openai` · `@effect-uai/responses`

GPT models via the Responses API, text embeddings, and Whisper/TTS speech.

- Language model: [Responses / OpenAI](/providers/responses/)
- Embeddings: [OpenAI](/embeddings/providers/responses/)
- Speech: [OpenAI](/speech/providers/openai/)

## Google

`@effect-uai/google`

Gemini models, Gemini embeddings, Gemini speech, and Lyria music.

- Language model: [Google Gemini](/providers/gemini/)
- Embeddings: [Google Gemini](/embeddings/providers/gemini/)
- Speech: [Google Gemini](/speech/providers/gemini/)
- Music: [Google Lyria](/music-generation/providers/gemini/)

## Mistral

`@effect-uai/mistral`

Mistral chat models plus Voxtral realtime STT and TTS, enough for a full
voice pipeline on one brand.

- Language model: [Mistral](/providers/mistral/)
- Speech: [Mistral (Voxtral)](/speech/providers/mistral/)

## Anthropic

`@effect-uai/anthropic`

Claude models via the Messages API.

- Language model: [Anthropic](/providers/anthropic/)

## ElevenLabs

`@effect-uai/elevenlabs`

Streaming STT/TTS and music generation.

- Speech: [ElevenLabs](/speech/providers/elevenlabs/)
- Music: [ElevenLabs Music](/music-generation/providers/elevenlabs/)

<!-- …Jina, Inworld, Exa, Perplexity, Tavily, Microsandbox, Deno follow the
     same one-brand, one-line, links-only pattern… -->
```

Each card is three lines of upkeep: package name, one positioning sentence,
and the links. Everything substantive stays one click away in the canonical
page.

## Alternatives considered

**A. One page per provider brand, grouped under a `Providers` sidebar tree.**
Closest to ai-sdk. Rejected for now: it adds ~10 nested sidebar rows against
an already-large sidebar, and each page either duplicates usage content (the
thing we are avoiding) or is a thin link list that does not earn a whole
page. The single-page matrix delivers the same browse-by-provider entry
point at a fraction of the surface. Revisit if any single provider grows
enough provider-specific prose (auth quirks, regioning, rate-limit guidance)
to justify a standalone page; at that point promote just that brand to its
own page and keep the matrix as the index.

**B. A matrix table dropped into an existing page (e.g. `start/why` or the
home page).** Cheaper still, but it buries the by-provider view where readers
will not look for it and gives it no stable URL to link out to. A named
top-level entry is worth the one sidebar line.

**C. Per-capability matrices only (no global hub).** The Speech overview
already has a provider matrix; we could add one to each capability. That
improves the by-use-case view but never produces the cross-capability,
by-provider story, which is the whole ask.

## Maintenance

Adding a provider becomes a three-touch change, all additive:

1. Write the canonical use-case provider page(s), as today.
2. Add the row to the matrix and a card to the hub (links only).
3. Add the leaf to the relevant capability `Providers` subsection, as today.

The hub never holds usage content, so it cannot fall out of sync with the
real docs beyond a stale link, which a link checker catches.

## Optional future enhancement

The matrix is mechanical: provider, package, and the set of capability pages
that exist. It could be generated from a small data file (or by globbing
`docs/**/providers/*.md`) at build time so the table can never drift from the
pages that actually exist. Worth doing only once the provider count makes
hand-maintenance annoying; at twelve it is still fine by hand.

---

# Landing page redesign (free-hand mockup)

A separate concern from the provider hub above (different page, same site),
but the other half of the "we are underselling effect-uai" conversation, so
it lives here too.

## What the current page does, and what it misses

Today the splash page (`docs/index.mdx`) renders three React components in
order: **Hero** (tagline + two buttons) -> **Features** (7 philosophy cards in
a 3-col grid) -> **Recipes** (curated cards + "28 and counting") -> **Get
started**.

It tells the "why this design" story well. It misses two things a first-time
visitor wants in the first fifteen seconds:

1. **A line of real code.** This is a developer library. One honest snippet
   out-converts three adjectives, and the canonical loop is already written
   (it is in the README, not on the landing page).
2. **The breadth.** Nowhere does the page say effect-uai spans 7 capabilities
   and 12 providers. The Features grid cannot carry that, because it answers
   "why this design", not "what can I build". Those are different axes and
   mixing them dilutes both.

## Principles for the redesign

- **Show code above the fold.** Drive, do not describe.
- **Keep the two axes apart.** Philosophy (Features) and breadth
  (Capabilities + Providers) are separate bands, never merged.
- **Honest numbers, no hype.** 7 capabilities, 12 providers, 28 recipes, MIT.
  "and counting" only where it genuinely grows.
- **One idea per band, one CTA out.** Preserve the current clean rhythm.

## The page, top to bottom

### 1. Hero (revised copy + a stat strip)

```
                    [ effect-uai logo ]

                   The loop is yours.

      Low-level, typed, streaming primitives for AI
      agents in Effect. One turn, one tool call,
      composed by you. No framework, no runtime to
      learn, no orchestrator to fight.

          [ Get started -> ]   [ View on GitHub ]

      7 capabilities · 12 providers · 28 recipes · MIT
```

Headline goes from "Effectful building blocks for agentic ai" to a sharper
claim ("The loop is yours."), with the descriptive line as the sub. The
mono stat strip is the first hint of breadth.

### 2. Quick taste (NEW: code-first band, right under the hero)

```
## Stream a turn. Run the tools. Continue until done.

  export const conversation = loop(initial, (state) =>
    Effect.gen(function* () {
      const lm = yield* LanguageModel        // swap provider any turn
      return lm.streamTurn({ history: state.history, model, tools: toolkit })
        .pipe(onTurnComplete((turn) =>
          Effect.sync(() => {
            const calls = Turn.getToolCalls(turn)
            if (calls.length === 0) return stop()
            return Toolkit.run(toolkit, calls).pipe(
              Toolkit.continueWithResults(Toolkit.appendToolResults(state, turn)))
          })))
    }))

  "This is the whole library: a stream you drive, not a runtime that drives you."
```

Reuse the README's canonical loop verbatim (single source of truth, rendered
through the existing Shiki path). This is the single most persuasive thing on
the page and it currently is not on it.

### 3. Why effect-uai (Features, kept, grid filled to 9)

Keep the philosophy cards. Fill the ragged 3-col grid by adding two cards
that are still "why this design" but quietly seed breadth and testability:

```
 Explicit control     Built on Effect       Composable primitives
 Streaming first      Typed errors          Carry your own state
 Recipes for the      Provider-portable     Test without the
 hard parts           (swap at the Layer)   network (MockProvider)
```

Now a full 3x3, no capability content smuggled in.

### 4. Capabilities (NEW band: "what you can build")

```
## Build agents that do more than chat

 [ Language models ]   [ Speech: STT + TTS ]   [ Embeddings ]
 [ Music ]             [ Web search ]          [ Sandboxes ]

 One consistent Effect interface per capability (generic tag +
 typed tag). Coming soon: reranking, realtime, image, video.

                    [ Explore capabilities -> ]
```

Six shipped capabilities, each a card linking to its overview
(`/concepts/language-model/`, `/speech/`, `/embeddings/`,
`/music-generation/`, `/search/`, `/sandboxes/`). The "coming soon" line
links the existing stub pages. This band is the core anti-undersell move.

### 5. Providers (NEW band: the hub's payoff)

```
## 12 providers. Swap at the Layer.

 OpenAI · Anthropic · Google · Mistral · ElevenLabs · Inworld
 · Jina · Perplexity · Exa · Tavily · Microsandbox · Deno

 Write against the generic tag; change the backend with one
 Layer. Mistral alone runs a full STT -> LLM -> TTS voice loop.

                     [ Browse providers -> ]
```

The hero stat says "12 providers"; this proves it and links straight to the
[Providers hub](#the-page-markdown-mockup) designed above. The Mistral line
ties back to the voice-loop recipe.

### 6. Recipes (kept)

Keep the curated cards, the "28 and counting" badge, and "All recipes". Add
one lead sentence: "Every hard part, worked end to end: approvals, fallback,
compaction, voice, sandboxes."

### 7. Get started (kept)

Install snippet plus the three first steps (Installation, Quickstart, Basic
usage), one primary CTA. As today.

## What changed, in one view

| Band         | Today | Proposed                                   |
| ------------ | :---: | ------------------------------------------ |
| Hero         |   ✓   | sharper headline + stat strip              |
| Quick taste  |       | **new** (canonical loop, code-first)       |
| Features     |   ✓   | filled to a clean 3x3 (9 cards)            |
| Capabilities |       | **new** (6 capability cards + coming-soon) |
| Providers    |       | **new** (12 providers + link to the hub)   |
| Recipes      |   ✓   | one lead sentence, otherwise unchanged     |
| Get started  |   ✓   | unchanged                                  |

The rhythm stays the same (one idea per band, scannable), but a visitor now
learns in seconds that this is code they own, across six capabilities and
twelve providers, with twenty-eight worked recipes.

## Build notes

- Three new components mirroring `FeaturesSection.tsx` /
  `RecipesSection.tsx`: `QuickTasteSection`, `CapabilitiesSection`,
  `ProvidersSection`, each driven by a small local data array. A `StatStrip`
  for the hero.
- The breadth numbers (12 providers, 6 capabilities, 28 recipes) are exactly
  the kind of thing to derive at build time (glob `packages/providers/*`,
  capability overview pages, and `recipes/*/README.md` plus
  `recipes-extras/*/README.md`) so the stat strip and badge can never drift.
  Same motivation as the provider-matrix generator noted above.
- Risk to watch: three new bands is more page. Keep each one short (a heading,
  a grid or a single row, one CTA) so the page stays calm. If it feels heavy,
  Capabilities and Providers can merge into one "What you can build" band
  with the capability cards on top and the provider row beneath.
