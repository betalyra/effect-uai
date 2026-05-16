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

- [Migrating to 0.5](/migrations/v0-5/) — `TurnEvent` migrated to
  `Data.TaggedEnum` (`type` → `_tag`, snake_case → PascalCase),
  `Encoding` → `EmbedEncoding`, generic `EmbedResponse<E>`,
  `Toolkit.outputEvent` / `outputEvents` removed, Gemini tool calling,
  new `Loop.stopWith` / `loopFrom`, `LanguageModel.turn` / `retry`,
  `Tool.fromStandardSchema`.
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
