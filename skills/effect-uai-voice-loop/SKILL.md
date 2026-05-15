---
name: effect-uai-voice-loop
description: Use when the user wants a voice assistant with effect-uai — live microphone STT to LLM to streaming TTS, follow-up utterance queueing, stop-word interruption, browser WebSocket audio, or one-fiber-per-turn voice pipelines. Covers Transcriber.streamTranscriptionFrom, LanguageModel.streamTurn, SpeechSynthesizer.streamSynthesisFrom, Stream.share, settleBurst, Fiber.interrupt, and partial history commits.
license: MIT
---

# effect-uai voice-loop

A voice assistant is three streams composed with Effect:

```text
mic audio -> Transcriber -> final utterances -> LanguageModel -> text deltas -> SpeechSynthesizer -> audio
```

Reach for this when the user says any of:

- "Build a voice assistant / talk to my agent"
- "Pipe live STT into an LLM and speak the answer"
- "Support stop/cancel while the assistant is talking"
- "Queue follow-up questions spoken during an answer"

## Pipeline shape

```ts
import { Stream } from "effect"

const stt =
  (cfg: PipelineConfig) =>
  <E, R>(audioIn: Stream.Stream<Uint8Array, E, R>) =>
    audioIn.pipe(
      Transcriber.streamTranscriptionFrom({
        model: cfg.stt.model,
        inputFormat: cfg.stt.inputFormat,
        wordTimestamps: false,
      }),
    )

const audio = LanguageModel.streamTurn({ history, model: cfg.llm.model }).pipe(
  Stream.filterMap(Turn.toTextDelta),
  SpeechSynthesizer.streamSynthesisFrom({
    model: cfg.tts.model,
    voiceId: cfg.tts.voiceId,
    outputFormat: cfg.tts.outputFormat,
  }),
)
```

The Layer must provide:

- `Transcriber` + `SttStreaming` for live mic input.
- `LanguageModel` for the assistant response.
- `SpeechSynthesizer` + `TtsIncrementalText` for token-streaming TTS.

## Turn model

Use one fiber per committed user utterance. The outer utterance stream
awaits each turn fiber sequentially:

- A normal follow-up spoken while the assistant is answering waits and
  becomes the next turn.
- A stop word interrupts the active turn fiber with `Fiber.interrupt`.
- The turn's interrupt handler commits whatever assistant text was
  already spoken.

Realtime STT can split one sentence into multiple finals. Use a small
settling window (`settleBurst`) before starting the LLM so close finals
become one user turn.

## Stop-word interruption

Listen to the shared STT stream in a separate watcher:

```ts
const stopWatcher = sharedFinals.pipe(
  Stream.filter((text) => containsStopWord(text)),
  Stream.runForEach(() => Ref.get(activeTurn).pipe(Effect.flatMap(Fiber.interrupt))),
)
```

Interrupt on finals, not partials. Partials are speculative and make
barge-in too eager. Finals-only plus explicit stop words is predictable:
ordinary speech queues, stop words cancel.

## Browser wire

Keep the browser thin:

```text
browser -> server: PCM mic frames
server -> browser: status JSON + PCM TTS frames
```

The server owns provider Layers, history, turn fibers, and cancellation.
On `assistant-cancelled`, tell the browser to flush its playback buffer
for immediate silence.

## Anti-patterns

- **Don't interrupt on partial transcripts.** They are guesses and will
  cut answers accidentally.
- **Don't run turns concurrently by default.** Voice UX usually wants
  one answer at a time with follow-ups queued.
- **Don't lose interrupted text.** Commit the accumulated assistant
  text in `Effect.onInterrupt` so history matches what the user heard.
- **Don't send markdown directly to TTS.** Strip or phoneticize at the
  TTS boundary while preserving original text for UI/history.

## See also

- Recipe source: `recipes/voice-loop/index.ts`
- For live STT only: `effect-uai-streaming-transcription`
- For LLM-token TTS only: `effect-uai-streaming-synthesis`
