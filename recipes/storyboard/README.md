---
title: Storyboard
description: Eight panels that look like one comic. Text holds the medium, reference sheets hold the cast, and a critic catches what drifted.
source: recipes/storyboard
icon: PiFilmSlate
---

Ask an image model for eight panels of the same story and you get eight
different people. It keeps no state between calls, so "a drone with one blue
scanning lens" is imagined fresh every time: a different body, a different
lens, sometimes a pair of them.

Repeating the style block fixes half of it. Line weight, palette and
"no lettering" are things words can carry, and restating them verbatim on
every prompt keeps the medium steady. Identity is the other half, and
words cannot carry it. That needs an image.

## Sheets, not story frames

Generate the cast first: one neutral, plain-background image per character,
prop and location. Then every panel is an `edit` conditioned on the sheets
it needs.

```ts
// sheets.nix, sheets.kite, sheets.warden, … were generated first
const panel = edit({
  model: "gpt-image-2",
  images: [sheets.nix, sheets.kite, sheets.roof],
  prompt: [
    "Comic panel 1 of 8.",
    style, // restated verbatim
    "Use the attached sheets as the exact reference for every character shown.",
    "Wide establishing. Dusk on the roof, ad-light glowing up through the smog",
    "below. Nix crouches among the aerials knotting the last ribbon onto the",
    "kite, which is nearly as tall as they are.",
  ].join("\n"),
})
```

Chaining alone, panel N from panel N-1 and nothing else, does drift, and
the drift compounds: each panel is a copy of a copy, and small deviations
are recursively amplified because every frame conditions the next
([AnchorEdit](https://arxiv.org/html/2606.11751v1),
[FreqEdit](https://arxiv.org/html/2512.01755)).

The fix is not to give up the chain. It is to never drop the anchor.
AnchorEdit keeps the first frame "as a persistent anchor that is never
evicted", which takes success from 33.5% to 52.9% over ten-plus turns, and
[VINCIE](https://arxiv.org/pdf/2506.10941) finds that with the full context
attached, no artifacts appear at all. So every panel here carries both: the
sheets and its scene, which never change, plus the panel before it, which
carries what only a picture can say about where people ended up.

The other reason not to anchor on a story frame alone: a wide establishing
shot has the character twelve pixels tall. There is no face in it to anchor
to. A sheet is drawn for the job.

## The pipeline

```
cast      generate the sheets                        concurrent
direct    an LLM breaks the beats into scenes and
          writes each shot                           one call
stage     draw each scene's empty establishing shot  concurrent
                          ↓
   then panel by panel, in order:
     render    edit from the scene, the panel before, and its sheets
     critique  a vision model checks it against all of them
     redo      re-render on rejection, up to `rounds`
```

The first three stages are barriers and run concurrently inside
themselves. The panels do not: each one is drawn with the panel before it
attached, so the board reads as a sequence rather than as eight
independent images that happen to share a cast.

`board` returns a `Stream` of events rather than an `Effect` of the
finished panels. A dozen image calls is minutes of wall clock, and each
sheet, scene, panel and rejected take lands as it happens.

The stage order is fixed and the model supplies the decisions inside it,
which is the shape published comic pipelines converge on
([COMIC](https://arxiv.org/html/2603.11048),
[CineAGI](https://arxiv.org/pdf/2604.23579),
[TheaterGen](https://arxiv.org/abs/2404.18919)). None of them hands a model
a tool belt and lets it decide the shape of the run.

**Direct** is one call for the whole board, so the director sees every beat
at once. It returns the scene breakdown plus a shot per beat: the drawing
prompt, the panel shape, its scene, and the sheet ids it needs. The plan
is written to `shots.json` beside the images, because a run you cannot read
is a run you cannot debug. Selection matters as the cast grows:
providers cap reference images per call (16 on OpenAI, 14 on Gemini with
per-kind splits), and a close-up of hands is diluted, not helped, by
attaching the skyline.

**Stage** draws each scene once, empty, from its location sheets, and every
panel in that scene is then drawn inside it. A scene is a place in one
state, so the same rooftop at dusk and at night in the rain is two. Without
this, panels sharing a location each invent their own version of it from
the same neutral sheet, and the reader sees a different building every
page. It costs one image per scene and nothing in wall clock, since the
scenes render concurrently.

Sheets carry design, never size. Each one is drawn at the same size on its
own blank square, so a fist-sized mug and a knee-high droid arrive looking
equally big, and the panel draws them that way: a mug as large as a head,
a character chest-high in one panel and waist-high in the next. Scale has
to come from words, so every sheet says how big the thing is and the
director states the relative sizes whenever two sheets share a panel.

Seeing every beat at once is also what lets the director carry state
forward. The artist draws each panel alone and never sees the others, so
anything an earlier beat established and a later one still assumes has to
be restated: what a character now carries, the time of day, the weather.
Skip it and the mug someone was handed in one panel is a paper cup in the
next. For the same reason the location sheet is attached whenever the
scene has one, or a rooftop quietly becomes a different rooftop.

**Critique** is what makes the consistency checked rather than hoped for.
Each panel goes back to a vision model alongside the sheets that produced
it, and anything that drifted comes back as one instruction. The re-render
runs from the sheets again with that note appended, never from the failed
panel, so its mistakes don't carry.

The critic judges design, never staging. A sheet says what a character is
made of, not how it stands, so pose and silhouette belong to the shot and
outrank the sheet. Without that split a critic rejects every low angle,
and a character the story rebuilds mid-book can never pass. Size is judged
too, but against the shot rather than the sheets, for the same reason the
sheets cannot carry it.

Rounds are bounded. A panel the critic keeps rejecting ships with
`rejected` set rather than looping forever, and the caller decides whether
to publish it.

## Running it

```bash
OPENAI_API_KEY=sk-... LLM_API_KEY=sk-... \
  pnpm tsx recipes/storyboard/run-node.ts
```

Two keys: one for the images, one for the director and critic. Point both
base URLs at the same gateway and both keys have to be that gateway's. Flags:
`--model`, `--llm-model`, `--resolution`, `--rounds`, `--concurrency`,
`--panels`, `--story`, `--out`, and `--base-url` / `--llm-base-url` to point
either at a gateway.

There is no `--aspect`: panel shape is the director's call, one of `3:2`,
`1:1` or `2:3` per shot, because a wide establishing shot and a close-up
want different frames and a page of identical rectangles reads as a
storyboard. `--resolution` sets the tier both stages use.

Panels are always sequential, so `--concurrency` bounds the cast and stage
stages only. Image endpoints rate-limit by images per minute rather than by
request, so drop it if the provider starts returning 429s. A sequential
board is roughly the sum of its panels rather than the slowest one: budget
a minute per panel at 1K.

Each run writes to `storyboard-out/<timestamp>/`, so runs accumulate rather
than overwrite:

```
page-1-panel-01.png …      the board
shots.json                 the director's plan: scenes, shots, attachments
sheets/nix.png …           what every panel was anchored on
scenes/roof-night.png …    the empty stage each panel was drawn inside
rejected/page-1-panel-03-take-1.png   what the critic threw out, and why
```

Keeping the rejected takes is the point of looking at a run: seeing what
drifted is how you tune the sheets and the style block. The board in
[`example/`](./example) is a committed run, kept for reference.

Five sheets and eight panels is thirteen images before any re-render, and
`gpt-image-2` bills image output per token. A 2K panel costs roughly four
times a 1K one, so start at 1K.

## Making it yours

A story is the whole creative surface, and it is data rather than code: a
style block, the sheets, and the beats. Write another file, pass
`--story path/to/it.json`, and none of the pipeline changes.

Two live in [`stories/`](./stories), same world, deliberately opposite:
[`kite.json`](./stories/kite.json) is the default, outdoors and mostly wide,
a kid and a machine over a neon canyon. [`noodle-stall.json`](./stories/noodle-stall.json)
is one cramped interior shot almost entirely in close-up, with a cast of
three and a character the story unmasks halfway through. Close faces are
the hardest thing to hold across eight panels, which is the point of having
the second one.

```json
{
  "style": "Style: full colour cyberpunk manga panel art … No text, no lettering.",
  "sheets": [{ "id": "nix", "description": "Character sheet. Nix, a scrawny …" }],
  "beats": [{ "page": 1, "shot": "Wide establishing. Dusk on the roof …" }]
}
```

Twelve things that decide whether it works:

- **The style block is about medium, never about a place.** Ink, shading,
  palette structure, what the drawing is not. Put "neon night" or "wet
  city" in it and the book holds together only while the story stays
  there: the moment a panel goes somewhere else, half the instruction
  stops applying and the model falls back to a generic illustration, soft
  clouds and airbrushed gradients and no ink at all. Setting belongs to
  the location sheets.
- **One location sheet per place.** A story that visits two places needs
  two, or the second one is unanchored and the critic has nothing to
  compare it against either.
- **Say who is not in a panel.** An empty frame invites the model to invent
  a protagonist for it, and since no sheet was attached for someone who
  was not supposed to be there, it invents their face and clothes too.
  Beats that leave the cast behind say so in words.
- **The style block bans lettering.** Image models render text badly, and
  speech bubbles are a layout job. That means the story has to be legible
  from pictures alone, so each beat changes one thing and the change is
  visible.
- **It also says what the drawing is not.** Left alone these models slide
  towards photoreal rendering. "No photorealism, no airbrushed gradients,
  no fine surface texture" earns its place.
- **Sheets name invariants a reader can check at a glance**, a cracked lens,
  a bent antenna, one mismatched arm, so drift is obvious rather than
  subtle.
- **Sheets say how big the thing is, in words.** Every sheet is drawn at
  the same size on its own square, so the picture cannot say it.
- **Anything that recurs gets a sheet.** A prop that appears in two panels
  and has no sheet is two different props.
- **Beats never describe anyone.** Appearance belongs to the sheets, medium
  to the style block, and a beat says only what changes: camera, action,
  place. Repeating a character's description invites a second version of
  them.
- **Every beat is an event, not a state.** With no lettering, a story is
  only what a reader can see happen. "Someone decides", "the drone gives
  up", "she realises": none of those have an appearance. Write the physical
  evidence instead, the thing let go of, the distance closed, the light
  that changed colour, and write it mid-happening rather than after.
- **A character without a face needs one part that can change.** A lens, a
  lamp, an antenna. Name it in the sheet, then let the beats change it, and
  a machine can carry a whole arc without a single expression.
- **A character the story changes needs a sheet per state.** Someone
  unmasked, rebuilt or transformed halfway through is two designs, and the
  second one gets invented unless you draw it first.

For characters, charm comes from proportion rather than accessories: a big
head on a small body reads as a character, a well-built box reads as
equipment.

Two things worth knowing that this recipe does not do:

- **A grid in one call.** Asking for a 3x3 of panels as a single image is
  consistent by construction, since it's one canvas. But you cannot
  re-render one panel, and each is small.
- **Refreshing the anchor.** Past a few dozen panels, regenerate the sheets
  from your best output and carry on. The sheets are just images; nothing
  stops you from replacing them.
