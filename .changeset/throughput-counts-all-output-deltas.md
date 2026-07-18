---
"@effect-uai/core": patch
---

`Metrics.throughput` now measures every delta that carries generated output, not
just `TextDelta`. `ReasoningDelta`, `RefusalDelta` and `ToolCallArgsDelta` count
too.

Previously a tool-using agent measured a rate near zero for an entire run: its
output is mostly `ToolCallArgsDelta`, and only prose was counted. Anyone
charting `effect_uai_output_*_per_second` for such an agent will see the number
jump from ~0 to a real rate. Prose-only turns are unaffected.

`ThroughputOptions.tokenizer` is now called with the new `OutputDelta` type
rather than `TurnEvent`, since it only ever receives output-carrying deltas.
Existing tokenizers that accept a full `TurnEvent` remain assignable.

`timeToFirstToken` keeps its own narrower definition of a content delta and is
unchanged.
