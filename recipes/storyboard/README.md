---
title: Storyboard
description: Tell a story in pictures. Your characters stay themselves across every panel, so eight images read as one comic instead of eight strangers.
source: recipes/storyboard
icon: PiImagesSquare
gallery:
  caption: One run of the default story, in order. Every panel drawn from the same reference sheets.
  images:
    - /media/storyboard/page-1-panel-01.webp
    - /media/storyboard/page-1-panel-02.webp
    - /media/storyboard/page-1-panel-03.webp
    - /media/storyboard/page-1-panel-04.webp
    - /media/storyboard/page-2-panel-05.webp
    - /media/storyboard/page-2-panel-06.webp
    - /media/storyboard/page-2-panel-07.webp
    - /media/storyboard/page-2-panel-08.webp
---

Ask for eight panels of your story and you get eight different worlds. The
model remembers nothing between calls, so your hero is a stranger by panel
three.

**Write the story once as JSON. Get a finished board back.**

```bash
OPENAI_API_KEY=sk-... pnpm tsx recipes/storyboard/run-node.ts
```

## Two models, one program

An image model draws. A language model directs it and judges the result.
Both are ordinary services, so the whole board is one Effect:

```ts
const board: Stream<BoardEvent, BoardError, ImageGenerator | LanguageModel>
```

- **`generate`** draws your cast on plain backgrounds, once.
- **`edit`** draws every panel, conditioned on the sheets it needs, so no
  panel is a copy of a copy.
- **`streamTurn`** with a `StructuredFormat` gets the director's plan back
  as typed data, not text to parse.

`board` is a **`Stream`**, so sheets, panels and rejected takes land on
disk as they happen instead of after the last call. The pipeline names only
the generic `ImageGenerator` and `LanguageModel` tags, so swapping provider
is a Layer change with no edit to the recipe.

```
cast     draw the sheets                  concurrent
direct   an LLM plans scenes and shots    one call
stage    draw each scene, empty           concurrent
             ↓  then panel by panel, in order:
         render → critique → redo
```

## Why this shape

- **Chaining alone drifts.** Panel N from panel N-1 is a copy of a copy:
  [AnchorEdit](https://arxiv.org/html/2606.11751v1) finds "minor artifacts
  or identity deviations can be recursively amplified", and
  [FreqEdit](https://arxiv.org/html/2512.01755) measures the noise stacking
  per turn.
- **The fix is not to drop the chain, but to never drop the anchor.**
  AnchorEdit keeps the first frame "as a persistent anchor that is never
  evicted": **33.5% → 52.9%** over ten-plus turns.
  [VINCIE](https://arxiv.org/pdf/2506.10941) sees no artifacts at all with
  the full context attached. Hence sheets _and_ the previous panel.
- **Fixed stages, model decisions inside them**, the shape published comic
  pipelines converge on ([COMIC](https://arxiv.org/html/2603.11048),
  [CineAGI](https://arxiv.org/pdf/2604.23579),
  [TheaterGen](https://arxiv.org/abs/2404.18919)). None hands a model a
  tool belt. That is why the plan lands in `shots.json`: a bad panel is a
  prompt you can edit, not a choice that happened once.
- **A sheet is drawn for the job.** A wide establishing shot has your
  character twelve pixels tall, with no face to anchor to.

## Your story file

[`stories/kite.json`](./stories/kite.json) is everything you edit.

```json
{
  "style": "Style: full colour cyberpunk manga panel art … No text, no lettering.",
  "sheets": [{ "id": "nix", "description": "Character sheet. Nix, a scrawny teenage …" }],
  "beats": [{ "page": 1, "shot": "Wide establishing. Dusk on the roof …" }]
}
```

- **`style`** — the medium: ink, shading, palette. Never a place.
- **`sheets`** — one per thing that recurs, props included. Name what a
  reader can spot, and say how big it is in words.
- **`beats`** — what happens, one per panel. Camera and action only;
  appearance belongs to the sheets.

Point `--story` at your own file. Nothing else changes.

Each run writes its own `output/storyboard/<timestamp>/`: the board, the
`sheets/` behind it, and the takes the critic `rejected/`.

| Flag                            |                                              |
| ------------------------------- | -------------------------------------------- |
| `--story`                       | Your story JSON                              |
| `--model` / `--llm-model`       | `provider:model` for the artist and director |
| `--resolution`                  | `1K`, `2K`, `4K`. Start at 1K                |
| `--rounds`                      | Retries when a panel drifts                  |
| `--panels`                      | Cut it short. `--panels 1` is a smoke test   |
| `--base-url` / `--llm-base-url` | A gateway the registry has no name for       |

**Swap either model without touching the code.** `--model
google:gemini-3.1-flash-image` draws on Gemini instead of OpenAI;
`--llm-model anthropic:claude-sonnet-5` hands directing to Claude. Drop the
prefix and you get OpenAI. `openrouter:` and `requesty:` route through a
gateway on one key.

Budget a minute per panel at 1K. 2K costs about four times as much.
