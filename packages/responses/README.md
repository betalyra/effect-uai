# @betalyra/effect-uai-responses

OpenAI Responses API provider for `@betalyra/effect-uai-core`.

Implements the `LanguageModel` contract against OpenAI's Responses API
(`POST /v1/responses` with SSE streaming). Tagged as a separate provider so
its model-specific options (`reasoning.effort`, `store`, `previousResponseId`)
can be reached at the call site without polluting the cross-provider surface.

## Install

```sh
pnpm add @betalyra/effect-uai-responses @betalyra/effect-uai-core effect
```

## Usage

```ts
import { layer as responsesLayer } from "@betalyra/effect-uai-responses"

const layer = responsesLayer({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "gpt-5",
})
```

The layer registers both the provider-typed `Responses` tag and the
generic `LanguageModel` tag.
