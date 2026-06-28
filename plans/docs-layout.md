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
