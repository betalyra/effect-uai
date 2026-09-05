---
title: Conversational image edit
description: Say what to change, keep the picture. Getting the image you want takes a few goes, and your subject survives every one of them.
source: recipes/conversational-image-edit
icon: PiPaintBrushBroad
gallery:
  caption: One session, in order. Each caption is the line that produced the image beside it.
  images:
    - src: /media/conversational-image-edit/turn-01.webp
      caption: "A four-seat noodle stall wedged under a concrete overpass at 4am … Empty, no people."
    - src: /media/conversational-image-edit/turn-02.webp
      caption: "add a grandma with a cyborg arm serving inside"
    - src: /media/conversational-image-edit/turn-03.webp
      caption: "add a humanoid alien as well as a human, and an orange cat lying on the ground next to the shop"
---

Getting the picture you actually want takes a few goes. But rewriting the
prompt each time starts over, and the model hands you a different picture.

**Say what to change. Keep the picture.**

```bash
GOOGLE_API_KEY=... pnpm tsx recipes/conversational-image-edit/run-node.ts
```

```
you  A four-seat noodle stall wedged under a concrete overpass at 4am … Empty, no people.
  ready    output/conversational-image-edit/2026-09-05T19-38-21/turn-01.jpg  in 11.3s

you  add a grandma with a cyborg arm serving inside
  ready    …/turn-02.jpg  in 9.3s

you  add a humanoid alien as well as a human, and an orange cat on the ground
  ready    …/turn-03.jpg  in 10.9s
```

The stall is still the same stall. Counter, stools, curtain and strung bulbs
all survive three rewrites; only what you asked for changes.

## Why it stops drifting

Chained edits fall apart. Each one is a copy of a copy, and by about the
sixth your character is someone else: [AnchorEdit](https://arxiv.org/html/2606.11751v1)
finds artifacts "can be recursively amplified", and
[BFL](https://bfl.ai/blog/flux-1-kontext) warns of visible drift after roughly
six turns.

So every edit here carries **two** pictures: the one you just changed, and the
**first** one, which is never dropped. That single anchor takes identity
retention from **33.5% to 52.9%** over ten-plus turns. It costs one array
entry.

## Watching it render

An image call is usually a minute of nothing. Some providers send preview
frames as the picture resolves, and where your terminal can draw images they
appear inline, no image library involved. Elsewhere they land in `previews/`
as they arrive.

Providers that cannot preview simply draw the whole image, and nothing else
about the session changes. Inline drawing works in iTerm2, kitty, WezTerm and
Ghostty, and in VS Code once `terminal.integrated.enableImages` is on.

## How it fits together

Lines in, events out, both ordinary Streams:

```ts
session(requests, draw): Stream<SessionEvent, AiError, ImageGenerator>
```

- **Turn-taking is back-pressure**, not a state machine. The next edit needs
  the last image, so a line is read only once the previous turn finishes.
- **`draw` is a parameter**, so whether you get previews is decided once, next
  to the Layer, instead of branching through the code.
- **The recipe never names a provider.** `--model` does, and swapping it is
  the only change.

| Flag           |                                                          |
| -------------- | -------------------------------------------------------- |
| `--model`      | `provider:model`, e.g. `google:gemini-3.1-flash-image`   |
| `--resolution` | `1K`, `2K`, `4K`. Start at 1K                            |
| `--previews`   | Preview frames per turn, 0 to 3. `0` forces whole images |
| `--base-url`   | A gateway the registry has no name for                   |

Ctrl-C ends the session. Every finished frame is written to
`output/conversational-image-edit/<timestamp>/`.
