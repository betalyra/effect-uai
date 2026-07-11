import type * as Job from "../job/Job.js"
import type * as Items from "./Items.js"
import type { Turn } from "./Turn.js"

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/**
 * Cross-provider deep-research request: a question in, a cited report out.
 * Deliberately minimal, only the input every provider shares. Depth, search
 * caps, and structured-output knobs vary too much to unify, so they live on
 * each provider's typed request, which extends this and narrows `model`.
 *
 * `history` reuses the `LanguageModel` input primitive: the common case is a
 * single user message with the question. There is no history threading. A
 * research call is one background job, not a conversation, but the input
 * encoding is shared.
 */
export type ResearchRequest = {
  readonly history: ReadonlyArray<Items.HistoryItem>
  /** Model / agent id. Provider default if omitted; each provider narrows. */
  readonly model?: string
}

// ---------------------------------------------------------------------------
// Result + job handle
// ---------------------------------------------------------------------------

/**
 * A completed research result is a `Turn`: one assistant message with the
 * report text and its citations on `OutputText.annotations`, plus usage.
 * Project it with `Turn.assistantText` / `Turn.citations` /
 * `Turn.decodeStructured`. There is no bespoke report type; the streaming
 * terminal (`TurnComplete.turn`) and the collected result are the same shape.
 */

/** Provider-tagged handle to a running research job, branded to `Turn`. */
export type ResearchJobRef = Job.JobRef<Turn>

/** Current state of a research job. See {@link Job.JobState}. */
export type ResearchState = Job.JobState<Turn>
