---
"@effect-uai/core": minor
---

Replace `@effect-uai/core/Inbox` with `@effect-uai/core/Settle`, the one home for acting on a pause in a stream of arrivals.

`drainBurst` moves across unchanged in name and signature, so call sites only swap the import path. `Inbox` held nothing else, and the same resetting-window idea had grown three implementations: this one over a queue, a copy inside the voice-loop recipe over a stream, and the metronome inside `Metrics.throughput`.

- `settleBurst(stream, settle, options?)` is `drainBurst` over a stream, one array per burst. Previously recipe-local. A failing source now fails the stream instead of arriving as a clean end, and the internal buffer is bounded (64 by default, `options.capacity` to change it) so a slow consumer suspends the source rather than growing memory.
- `onQuiet(stream, settle, emit)` passes every element through the moment it arrives and emits whatever `emit` yields once nothing has arrived for `settle`, at most once per quiet period. For live output that wants a boundary marker rather than batching.
- `drainBurst` now returns the batch in hand when the queue ends mid-burst, rather than failing and losing it. Interrupts and real failures still propagate.

Built on `onQuiet`, `Transcript.accumulatePartials(options?)` joins fragment `partial`s into the running hypothesis and commits it as a `final` after a silence. OpenAI Realtime streams token-sized deltas (`" Hi"`, `","`, `" how"`) where most providers send the whole utterance so far, and a model that transcribes continuously never sends a `final` at all. Partials are forwarded as they arrive, so captions stay live; a provider's own `final` resets the accumulator; the stream end flushes it. Do not pipe a provider that already accumulates through it.

**Migration.** `import { drainBurst } from "@effect-uai/core/Inbox"` becomes `import { drainBurst } from "@effect-uai/core/Settle"`, and `Inbox.drainBurst` becomes `Settle.drainBurst` on the namespace import. See the [0.16 migration guide](https://effect-uai.betalyra.com/migrations/v0-16/).
