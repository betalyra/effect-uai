---
"@effect-uai/ui": minor
"@effect-uai/core": minor
---

Program streams: what a station, a generation queue or a dashboard needs from the ui package.

- **`@effect-uai/ui/StreamView`**: a fold over a whole session stream. Every run by id in start order, stream-scoped `data` entries by name and id, `media`, and `live`. Pure, idempotent on `seq`, typed by a contract, and a drop-in fold for `Atoms.session`.
- **`media` event**: audio, video or a file (core `FileSource`: url, base64 or bytes), replaced in place by `id`. `RunView` gains a `media` block. A provider's file `ref` does not fit, so a key-gated file cannot reach the browser by accident.
- **Several runs on one stream**: `Run.within(runId)` tags a run's events, `Run.streamScoped` tags events outside any run, and `Run.sequenceOwned(streamId)` numbers the merged stream once. `Run.sequence` is unchanged for a single run.
- **`PROTOCOL_VERSION` is 3**: older clients fail on the new event type. Client and server release together.
- **`@effect-uai/core/Job`**: `JobStateSchema(result, error)` puts a job's state on a wire; the app chooses how a failure is encoded.
- **Recipes**: the radio station runs on the server (a reload resumes at your track; generation stays one track ahead of the listener), and the TV station (`recipes-extras/tv-station`) is back on the ui package.
