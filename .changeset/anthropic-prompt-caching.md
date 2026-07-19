---
"@effect-uai/anthropic": minor
---

Add `promptCaching` to the Anthropic layer config, so a long system prompt and
a large toolkit are paid for once rather than on every turn.

```ts
anthropicLayer({ apiKey, promptCaching: true })
anthropicLayer({ apiKey, promptCaching: { ttl: "1h" } }) // default is 5m
```

Off by default, since it changes how requests are billed. Nothing is marked up
per message: the cache point follows the conversation as it grows. Confirm it
is working via `usage.input_tokens_details.cached_tokens`, which was already
decoded but could never be non-zero before, because no request ever asked for
caching.
