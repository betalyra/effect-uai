---
title: Installation
description: Install effect-uai packages.
---

```sh
pnpm add @betalyra/effect-uai-core @betalyra/effect-uai-responses effect
```

Each provider is its own package. The core package has no provider deps, so
edge / browser builds only pull in what you actually use.
