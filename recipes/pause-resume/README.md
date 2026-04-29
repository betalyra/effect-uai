---
title: Pause and resume
description: Checkpoint state after each turn and resume across processes via previousResponseId.
---

# Recipe: Pause and resume

**Scenario.** Long-running agent. User hits "pause" - server should release
the HTTP connection. Later user hits "resume" - server picks up where it
left off.

Two regimes:

1. **Soft pause (in-process).** The pull-based loop already gives this for
   free: if downstream stops pulling, no more work happens.
2. **Hard pause (cross-process).** The body checkpoints state durably after
   each `turn_complete`, then `stop`s. A separate request later loads the
   saved state and re-enters `loop(savedState, body)`.

For the OpenAI Responses API, the natural checkpoint key is
`previousResponseId` - the provider doesn't replay on resume.

## Why a recipe, not a primitive

A `pause` decision in `Decision<S>` would couple the loop to a particular
durability model. `stop` plus a checkpoint event covers it.

## Status

Scaffolded only. Depends on `DurableEventLog` service interface
(see `plans/use-case-new-implementation.md` §9).
