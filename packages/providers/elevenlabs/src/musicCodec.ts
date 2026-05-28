import { Duration, Effect } from "effect"
import { warnDroppedWhen } from "@effect-uai/core/Capabilities"
import type { CommonGenerateMusicRequest } from "@effect-uai/core/Music"

// ---------------------------------------------------------------------------
// Composition plan (camelCase; snake-cased at the wire boundary)
// ---------------------------------------------------------------------------

/**
 * Composition plan accepted by `POST /v1/music` (and returned by
 * `POST /v1/music/plan`). Mirrors the wire `MusicPrompt` schema with
 * camelCase fields. Validation lives server-side (3 s to 10 min total,
 * up to 30 sections, 3 s to 2 min per section, ≤200 chars per lyric
 * line); we pass the body through and surface 422 errors via the
 * HTTP-status mapping.
 *
 * Reference: https://elevenlabs.io/docs/api-reference/music/compose
 */
export type ElevenLabsCompositionPlan = {
  readonly positiveGlobalStyles: ReadonlyArray<string>
  readonly negativeGlobalStyles: ReadonlyArray<string>
  readonly sections: ReadonlyArray<ElevenLabsSongSection>
}

export type ElevenLabsSongSection = {
  readonly sectionName: string
  readonly positiveLocalStyles: ReadonlyArray<string>
  readonly negativeLocalStyles: ReadonlyArray<string>
  readonly duration: Duration.Duration
  readonly lines: ReadonlyArray<string>
}

export const wireCompositionPlan = (plan: ElevenLabsCompositionPlan) => ({
  positive_global_styles: plan.positiveGlobalStyles,
  negative_global_styles: plan.negativeGlobalStyles,
  sections: plan.sections.map((s) => ({
    section_name: s.sectionName,
    positive_local_styles: s.positiveLocalStyles,
    negative_local_styles: s.negativeLocalStyles,
    duration_ms: Duration.toMillis(s.duration),
    lines: s.lines,
  })),
})

export const decodeCompositionPlan = (raw: unknown): ElevenLabsCompositionPlan => {
  const r = raw as {
    positive_global_styles?: ReadonlyArray<string>
    negative_global_styles?: ReadonlyArray<string>
    sections?: ReadonlyArray<{
      section_name: string
      positive_local_styles?: ReadonlyArray<string>
      negative_local_styles?: ReadonlyArray<string>
      duration_ms: number
      lines?: ReadonlyArray<string>
    }>
  }
  return {
    positiveGlobalStyles: r.positive_global_styles ?? [],
    negativeGlobalStyles: r.negative_global_styles ?? [],
    sections: (r.sections ?? []).map((s) => ({
      sectionName: s.section_name,
      positiveLocalStyles: s.positive_local_styles ?? [],
      negativeLocalStyles: s.negative_local_styles ?? [],
      duration: Duration.millis(s.duration_ms),
      lines: s.lines ?? [],
    })),
  }
}

// ---------------------------------------------------------------------------
// Bucket-2 warn-and-drop for Common fields ElevenLabs can't honor
// in prompt mode. No prompt construction; prompts always come from
// the caller verbatim. Migrate to `dropUnsupported` when capabilities
// Phase 0 lands.
// ---------------------------------------------------------------------------

export const warnDroppedPromptModeHints = (
  request: CommonGenerateMusicRequest,
): Effect.Effect<void> =>
  warnDroppedWhen(request.lyrics, {
    provider: "elevenlabs-music",
    capability: "lyrics",
    field: "lyrics",
    reason:
      "Prompt mode has no lyrics field. Use `compositionPlan` with per-section `lines` to provide lyrics.",
  })
