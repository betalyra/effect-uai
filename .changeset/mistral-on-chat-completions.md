---
"@effect-uai/mistral": patch
---

Rebuild the Mistral language model on `@effect-uai/chat-completions`. Mistral
speaks the OpenAI chat-completions dialect, so it now shares the streaming
decoder and tool encoding with the generic base, keeping only its wire quirks
local (bare-string `image_url`, `tool_choice: "any"`, and the `model_length`
finish reason). No public API change; `@effect-uai/chat-completions` becomes a
dependency.
