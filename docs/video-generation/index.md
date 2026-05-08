---
title: Video generation
description: Prompt to video — minutes per request, async by nature.
---

Text-to-video is the slowest agentic AI primitive — minutes per
request, not seconds.

That changes the shape of the abstraction. A synchronous `Effect` that
sits on a connection for five minutes is a recipe for timeouts and
abandoned fibers. Every provider's API admits this: you submit a job,
get an ID back, and either poll or subscribe to a webhook for the
finished video.

This is the _async job_ archetype, and it's the first capability where
"call the model and wait" stops being adequate. The abstraction needs
a `submit → track → fetch` shape with cancellable polling, finalizers
that release server-side resources on interrupt, and a stream of
progress events for UIs that want to show "rendering 38%".

## Coming soon

`@effect-uai/core` will ship a `VideoGenerator` service tag with this
async-job shape. Provider candidates:

- **Google Veo** — `veo-3` and successors.
- **OpenAI Sora** — when the API is broadly available.
- **Runway** — Gen-3 / Gen-4.
- **Luma** — Dream Machine.

The output reuses the existing `MediaSource` domain — URL or bytes —
so generated video composes with downstream tooling.

## Show interest

Open or +1 the
[video generation tracking issue](https://github.com/betalyra/effect-uai/issues/new?title=Capability%3A+Video+generation&body=I%27m+interested+in+video+generation+support.+Provider%28s%29%3A+%0APreferred+job+model+%28poll+%2F+webhook%29%3A+%0A%0AUse+case%3A+).
