import { Effect } from "effect"
import type { ContentBlock, HistoryItem } from "../domain/Items.js"

/**
 * Structured event emitted when a provider adapter drops a Common
 * request field because its wire API has no place to put it (bucket 2
 * per the capabilities policy: the provider has no structured
 * interpretation; the output is still valid, just less aligned with
 * the caller's hint).
 *
 * Carried on `Effect.logWarning` today for visibility; may be
 * promoted to a typed `AiError` variant in the future if callers need
 * to react programmatically. The shape itself is stable.
 *
 * @category capabilities
 */
export type CapabilityWarning = {
  readonly _tag: "CapabilityWarning"
  readonly provider: string
  /** The capability name as it appears in docs (`"lyrics"`, `"bpm"`). */
  readonly capability: string
  /** The Common-request field name that was dropped. */
  readonly field: string
  /** The value the caller passed; included when useful for debugging. */
  readonly value?: unknown
  /** Human-readable explanation; should suggest a workaround. */
  readonly reason: string
}

/**
 * Emit a structured `CapabilityWarning` via `Effect.logWarning`. Use
 * when a provider adapter receives a Common-request field it has no
 * structured wire field for, and would otherwise drop silently.
 *
 * Bucket-2 cases only (per the capabilities policy): the provider has
 * no interpretation; the output is still valid, just less aligned
 * with the caller's hint. For bucket-1 cases (structurally broken
 * output if dropped, like wrong audio format), fail
 * `AiError.Unsupported` instead.
 *
 * @example
 * ```ts
 * if (request.lyrics !== undefined) {
 *   yield* warnDropped({
 *     provider: "lyria",
 *     capability: "lyrics",
 *     field: "lyrics",
 *     reason: "Lyria 3 sync has no `lyrics` wire field. Embed in your prompt instead.",
 *   })
 * }
 * ```
 */
export const warnDropped = (warning: Omit<CapabilityWarning, "_tag">): Effect.Effect<void> =>
  Effect.logWarning("Capability dropped", { ...warning, _tag: "CapabilityWarning" })

/**
 * Shorthand for the most common shape: warn-and-drop when a specific
 * field on the Common request is set. The field's value is included
 * automatically.
 *
 * @example
 * ```ts
 * yield* Effect.all([
 *   warnDroppedWhen(request.lyrics, {
 *     provider: "lyria",
 *     capability: "lyrics",
 *     field: "lyrics",
 *     reason: "Lyria 3 sync has no `lyrics` wire field. Embed in your prompt instead.",
 *   }),
 *   warnDroppedWhen(request.duration, {
 *     provider: "lyria",
 *     capability: "duration",
 *     field: "duration",
 *     reason: "Lyria 3 clip is fixed at 30 s.",
 *   }),
 * ], { discard: true })
 * ```
 */
export const warnDroppedWhen = <T>(
  value: T | undefined,
  warning: Omit<CapabilityWarning, "_tag" | "value">,
): Effect.Effect<void> => (value === undefined ? Effect.void : warnDropped({ ...warning, value }))

/**
 * Warn when history carries a content block this provider's wire has no
 * place for, which its encoder therefore omits.
 *
 * History is provider-agnostic, so a turn one provider produced can be
 * replayed into another. A block only one provider can express
 * (`output_image`, which needs an assistant-role image part) then reaches
 * an encoder with nothing to map it to. Omitting is right, since failing
 * would break replaying a mixed history just to continue the text, but it
 * should not be silent.
 *
 * Call once from the effectful request path; the block encoders stay pure.
 *
 * @example
 * ```ts
 * yield* warnDroppedBlocks(history, "output_image", {
 *   provider: "anthropic",
 *   capability: "output_image",
 *   reason: "Assistant messages carry no image here. Convert with `imagesAsInput` to send it as user content.",
 * })
 * ```
 */
export const warnDroppedBlocks = (
  history: ReadonlyArray<HistoryItem>,
  type: ContentBlock["type"],
  warning: Omit<CapabilityWarning, "_tag" | "field" | "value">,
): Effect.Effect<void> => {
  const count = history.reduce(
    (n, item) =>
      n + (item.type === "message" ? item.content.filter((b) => b.type === type).length : 0),
    0,
  )
  return count === 0
    ? Effect.void
    : warnDropped({ ...warning, field: type, value: `${count} block(s)` })
}
