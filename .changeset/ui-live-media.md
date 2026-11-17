---
"@effect-uai/ui": minor
"@effect-uai/core": minor
---

Browser media and speech projections for live sessions.

- **`@effect-uai/ui/Media`** (browser only, not in the index): `mic`, `camera`, `level` and `pcmPlayer` as Effect streams and scoped resources, with their AudioWorklets inline. Fixes the worklets the recipes used to copy: the mic averages each output sample's window instead of picking samples, the player warms up again after an underrun, starts a reply shorter than its warmup, and carries an odd byte across chunks.
- **`Projection.fromTranscript` / `transcriptStep`**: a live transcript as one `data` entry per utterance (`Projection.Utterance`).
- **`Projection.fromRealtime` / `realtimeStep`**: a realtime session as frames; each response a run with its own audio channel, a barge-in `run-stopped { reason: "barge-in" }`, abandoned tool calls closed as cancelled.
- **`Input.Playback`**: the upstream message for how much of a channel's audio was heard.
- **`@effect-uai/core/Pcm`**: `s16leToF32`, `f32ToS16le`, `f32leToS16le` (any byte offset) and `wholeSamples`, a stream operator that cuts on sample boundaries.
- **Recipes**: voice-loop, realtime-voice-agent and camera-assistant run on live sessions; their config routes, tag bytes and worklet copies are gone.
