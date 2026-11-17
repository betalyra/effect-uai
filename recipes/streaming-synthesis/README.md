---
title: Streaming synthesis
description: Audio starts playing on the first chunk, not the last. Incremental text-in over WebSocket.
source: recipes/streaming-synthesis
---

Audio should start while the text is still being written.

This recipe sends incremental text into a streaming TTS provider and
plays audio chunks as they arrive. It is the shape you want when an LLM
is still producing the answer, but the user should already be hearing
the first phrase.

**Scenario.** You're reading model output aloud. The model writes
quickly but not instantly, and you don't want the user staring at a
spinner while a paragraph renders end-to-end. As soon as the model
has written enough text for the first phrase, you want the user to
hear it.

## The Shape

`streamSynthesisFrom` turns text deltas into audio chunks:

```ts
import { Stream } from "effect"
import * as SpeechSynthesizer from "@effect-uai/core/SpeechSynthesizer"

const audio = textWords.pipe(
  // textWords : Stream<string>  (e.g. words typed by the user)
  SpeechSynthesizer.streamSynthesisFrom({
    model: "eleven_flash_v2_5",
    voiceId: "JBFqnCBsd6RMkjVDRZzb",
    outputFormat: { container: "raw", encoding: "pcm_s16le", sampleRate: 24000, channels: 1 },
  }),
)
// audio : Stream<AudioChunk, AiError>
```

The input can be words typed by a user, tokens from a language model,
or any other `Stream<string>`. The provider connection stays open for
the whole utterance, so playback can begin before the final text exists.

## Run it

```sh
ELEVENLABS_API_KEY=... pnpm tsx recipes/streaming-synthesis/run.ts

# Inworld
INWORLD_API_KEY=... pnpm tsx recipes/streaming-synthesis/run.ts --provider inworld
```

Open <http://localhost:3000>, type a line and hit **Enter**. Audio
should start within ~500 ms regardless of how long the line is. Keep
typing: each line joins the same synthesis session.

## The live session

The page and the server talk over one
[live session](/agentic-ui/live-sessions/) from `@effect-uai/ui`,
opened on the first Enter:

```
[Browser]  { text } messages
   ↕  one WebSocket
[Server]  lines → Stream<string> → SpeechSynthesizer.streamSynthesisFrom
          → data "line" entries, speech as media frames on channel 0
[Browser]  plays channel 0 through a ring-buffered AudioWorklet
```

The session starts by declaring the speech channel: `channel-opened`
with `direction: "down"`, `audio/pcm` and 48 kHz. The page creates its
player at that rate. Each line the server accepts comes back as a
`line` entry, and the speech follows as binary media frames, which never
pass through the event log.

```ts
LiveSocket.handle({
  up: Say, // Schema.Struct({ text: Schema.String })
  handler: (up) => up.pipe(speechSession(provider), Frame.sequence(streamId)),
})
```

The demo plays raw PCM so it can schedule chunks directly. An
application could just as easily forward the chunks to another client,
write them to a file, or pipe them through a telephony connection.

This is the symmetric counterpart to
[Streaming transcription](/recipes/streaming-transcription/): the same
live session, with media flowing the other way.

## Provider Fit

Use a provider layer that registers `TtsIncrementalText`. ElevenLabs
and Inworld fit this shape today. OpenAI and Gemini can synthesize
finished text, but they do not accept incremental text input, so use
[Basic speech synthesis](/recipes/basic-speech-synthesis/) with those
providers.

## What This Generalizes To

To plug an LLM into the upstream side, replace the user's typed words
with the model's text deltas. [Voice loop](/recipes/voice-loop/) does
exactly that: LLM `Stream<string>` in, streaming TTS audio out.

The full source lives next to this README at
[`recipe.ts`](https://github.com/betalyra/effect-uai/blob/main/recipes/streaming-synthesis/recipe.ts).
