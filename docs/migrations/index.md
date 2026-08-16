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

- [Migrating to 0.12](/migrations/v0-12/): two narrow breaking changes.
  `providerData` is namespaced per provider (read Google deep-research traces via
  `GoogleDeepResearch.researchDataOf`; Perplexity no longer writes the slot), and
  `@effect-uai/exa/ExaDeepResearch` is removed (Exa retired the API; use OpenAI /
  Perplexity / Gemini). Additive: `@effect-uai/chat-completions` (a reusable
  OpenAI-compatible Chat Completions base for gateways like OpenRouter and
  Requesty), `@effect-uai/openai` as a single install re-exporting the Responses
  stack, Anthropic prompt caching, and throughput metrics that count every output
  delta.
- [Migrating to 0.11](/migrations/v0-11/): additive with one required action,
  bump the `effect` peer dependency from the pin `4.0.0-beta.57` to the range
  `>=4.0.0-beta.94 <5.0.0` (most of the release's internal diff is the
  mechanical ripple of that bump; effect-uai's own API renamed nothing). New:
  a `DeepResearch` capability (submit a question, a provider runs a background
  research job, collect one cited report) with four providers
  (`@effect-uai/responses`, `@effect-uai/google`, `@effect-uai/perplexity`,
  `@effect-uai/exa`) over the generic `Job` / `Citation` primitives; native
  grounding via provider-hosted tools that render end to end on OpenAI
  (`ResponsesTools`), Gemini (`GeminiTools`), and Anthropic (`AnthropicTools`);
  and `@effect-uai/ai-sdk`, a Vercel AI SDK compatibility package
  (`decodeMessages` + `toUIMessageStream`).
- [Migrating to 0.10](/migrations/v0-10/): mostly additive. One small
  breaking change to the tool layer: a `Tool` now carries a typed error `E`
  (added before `R`, so only hand-written full `Tool<...>` annotations need
  editing), and `Toolkit.run` propagates tool failures typed rather than
  silently showing them to the model (fail with a `string` / `Tool.fail`, or
  wrap the toolkit in `Toolkit.describeFailures`, to keep a failure
  model-visible). Additive: a `WebRead` capability (URL to clean markdown,
  providers `@effect-uai/firecrawl`, `@effect-uai/exa`, `@effect-uai/tavily`,
  `@effect-uai/jina`, plus `webReadTool`) and a `Browser` capability (drive a
  real browser over CDP via `@effect-uai/browser`, with `browserToolkit` and
  the verb tools).
- [Migrating to 0.9](/migrations/v0-9/): a tool-layer refactor (breaking
  but mechanical) plus an additive Mistral provider. A `Toolkit` is now a
  name-indexed record built with `Toolkit.make` and passed straight to
  `streamTurn` / `Toolkit.run` (no `Tool.toDescriptors` at the call site);
  plain and streaming tools unify into one `Tool.make` whose
  `run(input, emit)` returns an `Effect` (`Tool.streaming` / `finalize`
  removed); control and provider tools get honest kinds (`Tool.signal`,
  `Tool.interaction`, `Tool.provider`); independent toolkits combine with
  `Toolkit.compose`. Additive: `@effect-uai/mistral` (Mistral LLM plus
  Voxtral STT/TTS), enough to run an all-Mistral voice loop.
- [Migrating to 0.8](/migrations/v0-8/): purely additive. A new
  `WebSearch` capability in `@effect-uai/core` (a generic search service
  plus a ready-made `webSearchTool` for grounding an LLM), three search
  providers (`@effect-uai/perplexity`, `@effect-uai/exa`,
  `@effect-uai/tavily`), and two recipes (grounded answer, deep research).
  No breaking changes; bump dependencies and run typecheck.
- [Migrating to 0.7](/migrations/v0-7/): a capability-honesty pass
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
- [Migrating to 0.6](/migrations/v0-6/): the consistent-naming sweep
  plus additive speech features. Breaking but mechanical: "function
  call" → "tool call" terminology (`Item` → `HistoryItem`,
  `FunctionCall` → `ToolCall`), modules `Outcome` → `ToolResult` and
  `Resolvers` → `Approval`, `Toolkit.executeAll` → `run`,
  `Tool.AnyKindTool` → `AnyTool`, `ToolEvent.Intermediate` → `Progress`,
  and a trimmed `Loop` surface (`loopFrom` → `loopOver`,
  `stop()` / `stop(state)`, `nextAfter` / `stopAfter` removed); the wire
  format is unchanged. Additive (no migration needed): multi-speaker
  dialogue and custom pronunciations on `SpeechSynthesizer`.
- [Migrating to 0.5](/migrations/v0-5/): `TurnEvent` migrated to
  `Data.TaggedEnum` (`type` → `_tag`, snake_case → PascalCase),
  `Encoding` → `EmbedEncoding`, generic `EmbedResponse<E>`,
  `Toolkit.outputEvent` / `outputEvents` removed, Gemini tool calling,
  new `Loop.stopWith` / `loopFrom`, `LanguageModel.turn` / `retry`,
  `Tool.fromStandardSchema`.
- [Migrating to 0.4](/migrations/v0-4/): purely additive. New speech
  (`Transcriber`, `SpeechSynthesizer`) and music (`MusicGenerator`)
  services, shared `Audio` / `Transcript` / `Music` domain, and three
  new provider packages (`@effect-uai/openai`, `@effect-uai/elevenlabs`,
  `@effect-uai/inworld`). No breaking changes.
- [Migrating to 0.3](/migrations/v0-3/): `streamUntilComplete` → `onTurnComplete`,
  `nextStateFrom` → `continueWith` (now pipe-friendly), `Match` module
  removed, tool requirements flow through `R`, new `loopWithState`,
  new embedding subsystem.

## Versioning policy

- **`0.x.y`**: minor (`x`) bumps may break source compatibility; patch
  (`y`) bumps don't. Migration pages live at this level.
- **Post-1.0**: semver. Breaking changes only on majors; each major
  gets a migration page.

## Using Claude to migrate

These migration pages are the source of truth. Point your AI coding
agent (Claude Code, Cursor, …) at the page for your target version, or
paste its "old → new" diffs: the pages are written in operator form ("if
you see X, write Y") so the agent can apply the rewrites across your
codebase directly.

## Release process

For maintainers: every release that contains a breaking change MUST
ship:

1. A new `docs/migrations/v{X.Y}.md` page following the template of the
   most recent migration page.
2. A sidebar entry in `webpage/astro.config.mjs` linking the new page.
3. CHANGELOG entries (via a changeset) cross-linked to the migration page.

Treat these like CHANGELOG bumps: required in the same PR, not
"I'll do it later." Stale migration content actively misleads users (and
Claude) into recommending APIs that no longer exist.
