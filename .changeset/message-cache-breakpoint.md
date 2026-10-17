---
"@effect-uai/core": minor
"@effect-uai/responses": minor
"@effect-uai/anthropic": minor
---

`Items.Message` gains an optional `cacheBreakpoint`. Set it to `true` to end a cached prompt prefix after that message, for example a long system prompt shared by calls whose user content differs:

```ts
const history = [
  { ...Items.systemText(longSharedPrompt), cacheBreakpoint: true },
  Items.userText(question),
]
```

- Responses sends `prompt_cache_breakpoint: { mode: "explicit" }` on the message's last content block (GPT-5.6 and later). The API takes it on input blocks only, so a marked assistant message sends nothing.
- Anthropic sends `cache_control` on the message's last content block, with the layer's `promptCaching` TTL (5m when unset), whether or not `promptCaching` is on. A marked system message sends `system` as one text block per system message instead of a joined string.

Other providers ignore it. History without the field encodes exactly as before.
