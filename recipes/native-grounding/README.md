---
title: Native grounding
description: Let the provider ground the answer with its own hosted web search. Drop a provider-hosted tool into the toolkit and get a cited answer, no search backend to wire.
source: recipes/native-grounding
icon: PiGlobe
---

Some providers search the web for you. Hand the model a _provider-hosted_
tool and it searches on its own side, then answers with citations attached.
This is the native counterpart to [grounded answer](/recipes/grounded-answer/):
same agent loop, but you skip wiring a search backend.

## Drop the hosted tool in

Each provider ships its own constructor, since the tools are provider-specific:

```ts
import { googleSearchTool } from "@effect-uai/google/Gemini"
import { webSearchTool as anthropicWebSearch } from "@effect-uai/anthropic/Anthropic"
import { webSearchTool as openaiWebSearch } from "@effect-uai/responses/Responses"

const searchTool = googleSearchTool // or anthropicWebSearch() / openaiWebSearch()
```

You never write a `run` for it and the loop never asks you to execute it. It
sits next to your own `Tool.make` tools; the model uses it to ground its
answer. A hosted tool only works with the provider that hosts it: give a
Gemini tool to the Anthropic model and the request fails with
`AiError.Unsupported`.

## Run it

```bash
GOOGLE_API_KEY=...    pnpm tsx recipes/native-grounding/run.ts
ANTHROPIC_API_KEY=... pnpm tsx recipes/native-grounding/run.ts --provider=anthropic
OPENAI_API_KEY=...    pnpm tsx recipes/native-grounding/run.ts --provider=openai

GOOGLE_API_KEY=... pnpm tsx recipes/native-grounding/run.ts \
  --question "who won the 2026 F1 season opener?"
```

The answer streams to stdout as the model writes it. `run.ts` and
`run.ts` differ only in the platform HttpClient.
