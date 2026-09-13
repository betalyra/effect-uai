---
"@effect-uai/core": minor
---

`TranscriptEvent` is now a `Data.TaggedEnum`, so it ships `TranscriptEvent.$is`, `$match` and constructors alongside the union.

Nothing changes for existing code. A `TaggedEnum` expands to the same `{ _tag } & Props` union, optional fields included, so every adapter and recipe that builds these events as object literals keeps compiling untouched, and the tag strings are unchanged on the wire.

What it adds is a guard that accepts `unknown`. `isPartial`, `isFinal`, `isSpeechStarted`, `isUtteranceEnded`, `isAudioEvent`, `isMetadata` and `isError` are now `$is` under the hood and keep their names, so they can be used from a stream operator scanning a mixed stream rather than only where the element is already known to be a `TranscriptEvent`. `TranscriptEvent.$match` gives exhaustive handling without a hand-written switch.

This is what let `Metrics.Transcript.finalLatency` read transcript events out of a stream that also carries metric samples, without structural tag sniffing.
