# Plan — recipe ideas

A running list of recipe ideas for the docs / `recipes/` folder. Each row is
self-contained: a short blurb a user would scan on the landing page plus a
proposed icon from our set (`react-icons/pi`, Phosphor).

The list pulls from `plans/use-case-new-implementation.md` (especially the
Tier 3 recipe bucket and the "use cases not yet on either list" section) and
from open follow-ups in the gaps docs.

## Existing recipes (for reference)

| Recipe               | One-line                                                                     | Icon                       |
| -------------------- | ---------------------------------------------------------------------------- | -------------------------- |
| Basic usage          | Smallest end-to-end shape: streaming deltas, a tool call, a final answer.    | `PiHandWaving`             |
| Multi-model fallback | Fall back across providers on `RateLimited` / `Unavailable`.                 | `PiArrowsClockwise`        |
| Auto-compaction      | Summarize history when a token / turn budget is exceeded.                    | `PiArrowsInLineHorizontal` |
| Pause and resume     | Checkpoint after each turn, resume later via `previousResponseId`.           | `PiPause`                  |
| Mid-stream abort     | Cancel the loop and the upstream HTTP request via scope-based cleanup.       | `PiHandPalm`               |
| Multi-model compare  | Fan one prompt out to OpenAI, Google, and Anthropic concurrently.            | `PiGitFork`                |
| Model council        | Same fan-out, but the models cross-evaluate and the winner is streamed back. | `PiGavel`                  |

## Proposed recipes

| Recipe                        | One-line                                                                                                                                                                      | Icon                  | Source                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------- |
| Tool call approval            | Pause the loop on sensitive tool calls (`delete_database`, `send_email`), surface them as `awaiting_approval` events, resume with the user's verdict.                         | `PiShieldCheck`       | use-case audit §11.1                   |
| Agent loop with input queue   | Drive the loop from a `Queue<UserAction>` fed by an external input source (WS, HTTP, CLI). Optional `Stream.groupedWithin` debounce coalesces bursts into one batch per turn. | `PiQueue`             | use-case audit §7, user-requested      |
| Control tools                 | Model-callable tools whose output the loop body interprets directly (e.g. `upgrade_model`, `set_temperature`) instead of feeding back to the model.                           | `PiSlidersHorizontal` | use-case audit §2                      |
| Auto-upgrade on tool failures | After N consecutive failed tool calls, swap `gpt-5-mini` for `gpt-5` and clear the failure counter. State-threading recipe.                                                   | `PiArrowFatLineUp`    | use-case audit §1                      |
| Sub-agent delegation          | Tool whose handler runs its own `loop` and folds the sub-stream back. Shows how to plumb sub-agent deltas through the parent stream.                                          | `PiTreeStructure`     | use-case audit §11.3                   |
| Streaming tool results        | Long-running tools (sandboxed exec, web search) emit progress events while running; the terminal `FunctionCallOutput` is fed to the next turn.                                | `PiBroadcast`         | use-case audit §11.2                   |
| Per-request token budget      | Cap a request at N tokens, both per-turn (cheap) and mid-stream via a tokenizer + `Stream.takeWhile` (relies on scope-based HTTP abort).                                      | `PiGauge`             | use-case audit §8                      |
| Per-tool timeout              | Wrap `executeOne` with `Effect.timeout` and convert `TimeoutException` into a typed tool-failure output.                                                                      | `PiTimer`             | use-case audit §11.5                   |
| Mid-turn user injection       | Handle a user message arriving while a turn is generating, two flavors: abort + restart with new history, or queue + drain at next turn boundary.                             | `PiPaperPlaneTilt`    | use-case audit §11.8                   |
| Validation + retry            | Validate the model's structured output against a `Schema`, capture the failure in a `Ref`, and retry the turn with the validation error as feedback.                          | `PiSealCheck`         | use-case audit §11 (cuttlekit Phase 3) |
| Replay mode                   | Drive the loop against a recorded delta tape via a swap-in `LanguageModelService` Layer for deterministic eval / regression tests.                                            | `PiCassetteTape`      | use-case audit §11.9                   |
| OTel-traced loop              | Wrap each turn in a `gen_ai.completion` span and each tool call in a child span; the outer loop is the parent.                                                                | `PiChartLineUp`       | use-case audit §11.10                  |
| Cost tracking                 | `CostTracker` Layer mapping `gen_ai.request.model` + `Usage` to USD, emitted as a stream event after each `turn_complete`.                                                    | `PiCoins`             | use-case audit §11 (compass)           |
| SSE / JSONL frontend bridge   | Encode the loop's `Stream<Event>` as `text/event-stream` or `application/x-ndjson` for an HTTP endpoint; reciprocal browser decoder.                                          | `PiBroadcast`         | use-case audit §6                      |

## Notes on icons

All icons assumed to live in `react-icons/pi`. If a name turns out not to
exist when implementing, the closest Phosphor neighbour is fine — the goal is
the visual semantic, not the exact string. Two recipes currently share
`PiBroadcast` (streaming tool results, SSE bridge); pick one or swap the
SSE bridge to e.g. `PiPlugsConnected` when both land.
