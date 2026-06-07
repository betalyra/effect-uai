---
title: Migrations
description: Per-version upgrade guides for effect-uai. Renames, removed APIs, and behavior changes with copy-pasteable before/after diffs.
---

effect-uai is pre-1.0; minor releases (`0.x`) can include breaking changes.
Each release that contains breaking changes ships a migration page on this
site with the full "old → new" picture: renames, removals, behavior
changes, and recommended migration order.

The [CHANGELOG](https://github.com/betalyra/effect-uai/blob/main/packages/core/CHANGELOG.md)
covers the _why_ (one entry per PR). These pages cover the _how_ (one
page per release, written for a reader doing the upgrade in front of
their editor).

## Versions

- [Migrating to 0.7](/migrations/v0-7/) — a capability-honesty pass
  across audio and embeddings. `AudioBlob.durationSeconds: number`
  becomes `duration: Duration.Duration` (flowing through STT, TTS, and
  music). STT: `GeminiTranscriber` removed (use OpenAI / ElevenLabs /
  Inworld), `prompt` splits into `prompt` + `biasingTerms`,
  `TranscriptResult.durationSeconds → duration`. TTS: `PhoneticEncoding`
  and `CustomPronunciation.encoding` removed (IPA-only), pronunciations
  now fail `Unsupported` on providers without an IPA path, `DialogueTurn`
  trims to `{ voiceId, text }`. Embeddings: `EmbedEncoding` trimmed to
  `float32 | int8 | binary` (sparse / multivector move to `JinaEncoding`),
  mismatched encoding / image / multi-part now fail `Unsupported` instead
  of degrading silently. Music: `prompts → prompt`, `bpm` / `scale` /
  `instrumental` dropped, `MusicResult` composes `AudioBlob`
  (`result.bytes → result.audio.bytes`), `generate` returns
  `GenerateResult` (`primary` + `variants[]`), `streamGenerationFrom`
  yields `MusicStreamEvent`. LLM (no rewrites): Gemini `toolChoice` now
  mapped, Gemini URL images now `Unsupported`, Lyria clip reports mp3
  honestly. Additive (no migration needed):
  `@effect-uai/elevenlabs/ElevenLabsMusicGenerator`,
  `@effect-uai/core/Capabilities` warn-and-drop helper, ElevenLabs
  `pronunciationDictionaryLocators`, multi-provider recipe runner via
  `--provider=`.
- [Migrating to 0.6](/migrations/v0-6/) — the consistent-naming sweep
  plus additive speech features. Breaking but mechanical: "function
  call" → "tool call" terminology (`Item` → `HistoryItem`,
  `FunctionCall` → `ToolCall`), modules `Outcome` → `ToolResult` and
  `Resolvers` → `Approval`, `Toolkit.executeAll` → `run`,
  `Tool.AnyKindTool` → `AnyTool`, `ToolEvent.Intermediate` → `Progress`,
  and a trimmed `Loop` surface (`loopFrom` → `loopOver`,
  `stop()` / `stop(state)`, `nextAfter` / `stopAfter` removed); the wire
  format is unchanged. Additive (no migration needed): multi-speaker
  dialogue and custom pronunciations on `SpeechSynthesizer`.
- [Migrating to 0.5](/migrations/v0-5/) — `TurnEvent` migrated to
  `Data.TaggedEnum` (`type` → `_tag`, snake_case → PascalCase),
  `Encoding` → `EmbedEncoding`, generic `EmbedResponse<E>`,
  `Toolkit.outputEvent` / `outputEvents` removed, Gemini tool calling,
  new `Loop.stopWith` / `loopFrom`, `LanguageModel.turn` / `retry`,
  `Tool.fromStandardSchema`.
- [Migrating to 0.4](/migrations/v0-4/) — purely additive. New speech
  (`Transcriber`, `SpeechSynthesizer`) and music (`MusicGenerator`)
  services, shared `Audio` / `Transcript` / `Music` domain, and three
  new provider packages (`@effect-uai/openai`, `@effect-uai/elevenlabs`,
  `@effect-uai/inworld`). No breaking changes.
- [Migrating to 0.3](/migrations/v0-3/) — `streamUntilComplete` → `onTurnComplete`,
  `nextStateFrom` → `continueWith` (now pipe-friendly), `Match` module
  removed, tool requirements flow through `R`, new `loopWithState`,
  new embedding subsystem.

## Versioning policy

- **`0.x.y`** — minor (`x`) bumps may break source compatibility; patch
  (`y`) bumps don't. Migration pages live at this level.
- **Post-1.0** — semver. Breaking changes only on majors; each major
  gets a migration page.

## Using Claude to migrate

The [`effect-uai-migrate` skill](https://github.com/betalyra/effect-uai/blob/main/skills/effect-uai-migrate/SKILL.md)
encodes per-version rewrite rules in operator form: "if you see X,
write Y." Invoke it from Claude Code:

```
/skill effect-uai-migrate
```

The skill is one source of truth shared between the migration pages
here and the assistant. New release? Update both in the same PR (see
[release process](#release-process) below).

## Release process

For maintainers — every release that contains a breaking change MUST
ship:

1. A new `docs/migrations/v{X.Y}.md` page following the template of the
   most recent migration page.
2. A new "X.(Y-1) → X.Y" section in `skills/effect-uai-migrate/SKILL.md`.
3. A sidebar entry in `webpage/astro.config.mjs` linking the new page.
4. CHANGELOG entries cross-linked to the migration page.

Treat these like CHANGELOG bumps: required in the same PR, not
"I'll do it later." Stale skill content actively misleads users (and
Claude) into recommending APIs that no longer exist.
