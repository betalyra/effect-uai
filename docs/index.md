---
title: effect-uai
description: Low-level primitives for AI agents in Effect.
template: splash
hero:
  tagline: Low-level primitives for AI agents in Effect - you own the loop.
  actions:
    - text: Get started
      link: /start/installation/
      icon: right-arrow
      variant: primary
    - text: View on GitHub
      link: https://github.com/betalyra/effect-uai
      icon: external
      variant: minimal
---

## Why effect-uai

Most agent frameworks hide the loop. `effect-uai` exposes it - state is a
plain record, `Decision<S>` controls iteration, the body is a `Stream`. Every
agent shape (retry, fallback, compaction, pause/resume, abort) falls out of
composition rather than framework features.

## Packages

- **`@betalyra/effect-uai-core`** - primitives: loop, conversation, items,
  tools, streaming codecs, errors.
- **`@betalyra/effect-uai-responses`** - OpenAI Responses API provider.
