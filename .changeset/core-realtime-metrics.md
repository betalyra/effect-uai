---
"@effect-uai/core": minor
---

Add `Metrics.Realtime`, the first meters for a realtime session, and reorganize `@effect-uai/core/Metrics` around the event stream each meter reads.

`timeToFirstAudio` is an ordinary stream operator: stack it on `session.events` and it emits one `TimeToFirstAudio` per response, carrying `elapsed`, `anchor` and the response index, with everything else passing through untouched. The clock stops at the first `AudioDelta` and the segment ends at `ResponseDone`. `Telemetry.record` exports it like any other sample, under `effect_uai_response_time_to_first_audio`.

Where the clock _starts_ is the only setting, and it decides what the number means, so it rides along on the sample and in the measurement's `attributes`. Two anchors can then be split or grouped on a dashboard but never silently averaged.

- **Default**: the provider's `SpeechStopped`. Only OpenAI emits it. It excludes the provider's endpointing window, which is configured rather than reported (`silence_duration_ms`, 500 ms by default on OpenAI), so the wait a person felt is roughly the reported number plus that silence.
- **`from: ref`**: an instant you stamped with `Metrics.Meter.mark(ref)`, for a start the session's own events cannot show. Anchored on the acoustic end of speech this is the industry's time to first audio byte; anchored on a push-to-talk release it is intent instead. Each mark is measured from once, so a response with no fresh mark reports nothing rather than counting from the turn before it.

A response whose anchor never arrived reports nothing rather than a number measured from the wrong place. On the default anchor that covers Gemini Live, which announces no end of speech at all, as well as typed input and the response that resumes after a tool result.

`Metrics.Realtime.usage` reports tokens per response and summed over the session, from the usage a response carries as it ends. A response that reports none emits nothing rather than a row of zeroes, and still spends its index. The counters are the same `effect_uai_*_tokens` names the turn meters use, so spend adds up across capabilities on one dashboard.

`Metrics.Transcript.finalLatency` measures from `utterance-ended` to the `final` that commits it, once per utterance: the pause a pipeline waits through before it can act on what was said. `Metrics.Speech.timeToFirstByte` measures from the request to the first `AudioChunk`, the only synthesis latency a listener notices. Both report nothing where their anchor never arrives, so a transcriber that emits no VAD events stays silent rather than reporting a number measured from the wrong place.

The module is now a barrel over `observability/metrics/`. `MetricEvent`, `Measurement`, `makeEvent`, `isMetricEvent` and `metricEvents` stay flat, since every meter and the exporter share them. The meters are namespaced by the events they read: `Metrics.Turn.*` for `TurnEvent`, `Metrics.Realtime.*` for `RealtimeEvent`, `Metrics.Transcript.*` for `TranscriptEvent` and `Metrics.Speech.*` for synthesized audio. `Metrics.Meter.*` is the capability-free plumbing they are built on (`Anchor`, `timeToFirst`, `segmentDuration`, `mark`), which is what a custom meter should reach for, and `Metrics.Usage.*` is the token accounting they share: `usageTotals`, and `ReducerUsage`, a `Reducer` for `Usage` so summing spend composes and absent fields stay absent.

`timeToFirstToken`, `timeToCompletion` and the turn meters are unchanged in signature, behaviour, event shape and metric name; they are now `timeToFirst` and `segmentDuration` plus `TurnEvent` predicates.

**Deprecation.** `Metrics.timeToFirstToken`, `throughput`, `tokenTotals`, `timeToCompletion` and `allMetrics` (and their option and event types) still work at the top level but are deprecated in favour of `Metrics.Turn.*`, and will be removed in a later minor.
