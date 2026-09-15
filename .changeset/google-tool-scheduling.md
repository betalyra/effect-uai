---
"@effect-uai/google": patch
---

Send `scheduling` on every Gemini Live tool result, defaulting to `WHEN_IDLE`, and expose it as `toolScheduling` on `GeminiLiveRequest`.

`gemini-3.8-live` keeps generating while a tool runs, where earlier Live models stopped and waited. A tool result sent with no `scheduling` field then takes the server's default, which is to interrupt: the model cuts off whatever it was saying to report the result. For an agent told to say "let me look that up" before a slow call, the interruption lands on exactly those words, and the listener hears the sentence chopped mid-word as the answer arrives.

`WHEN_IDLE` lets the current utterance finish and the result follow. `"interrupt"` restores the previous behaviour for a result that cannot wait, and `"silent"` files it as context without announcing it.

Only the wire default changes; nothing in the session API moves. On a model that blocks during a tool call there is nothing to schedule around, so the field makes no difference there.
