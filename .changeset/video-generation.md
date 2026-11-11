---
"@effect-uai/core": minor
"@effect-uai/fal": minor
"@effect-uai/google": minor
---

Video generation: a `VideoGenerator` capability with fal and Gemini Omni providers.

- **`@effect-uai/core/VideoGenerator`**: generation as an explicit background job. The service is four wire calls: `submit` returns a `VideoJobRef` (plain data, persist it and collect from another process), `status` is one poll, `cancel` stops the job, `read` streams a produced video. The loops are opt-in accessors over the tag: `watch` (every polled state), `collect` (poll until settled), `generate` (submit then collect, cancelling the provider's job if interrupted). `toStream` / `toBytes` read a video through the provider that produced it. `VideoJobRef` is also a schema for decoding a persisted ref.
- **`@effect-uai/core/Video`**: `VideoSource` (`url`, `base64`, `bytes`, and `ref` for a file only its provider can read), `VideoInput` (`FirstFrame`, `LastFrame`, `ReferenceImage`, `ReferenceVideo`), `GeneratedVideo`, `VideoResolution`. `MediaRef` joins `Media`.
- **`@effect-uai/core/VideoDownload`**: `read(source, { provider, headers? })`, the building block adapters use for public URLs and inline data.
- **`@effect-uai/core/Job`**: `JobState` is a `Data.TaggedEnum` (constructors and matchers; still a structural union) with an optional `queuePosition` on `Pending`; `watch` streams every polled state; `JobRef` and `refSchema<A>()` decode persisted refs. `collect` is built on `watch` and keeps its behaviour.
- **`@effect-uai/fal/FalVideoGenerator`**: fal's queue API (MiniMax H3, Seedance, Veo, Kling, LTX and any other fal video endpoint by path). Frame fields, duration and resolution are encoded per endpoint family; anything else goes through `wire`.
- **`@effect-uai/google/GeminiOmniVideoGenerator`**: Gemini Omni (`gemini-omni-1.2-flash`) over the Interactions API in background mode. Clips are delivered as Files API references by default and read with the API key through `read`; first and last frames map to `image_to_video`, references to `reference_to_video`.
