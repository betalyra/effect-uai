import { Array as Arr, Duration, Effect, Option, pipe } from "effect"
import * as AiError from "@effect-uai/core/AiError"
import * as Capabilities from "@effect-uai/core/Capabilities"
import type { VideoResolution } from "@effect-uai/core/Video"
import { PROVIDER } from "./codec.js"

/**
 * How one family of fal endpoints spells the portable knobs. fal unifies
 * auth, the queue and the result envelope, but not the request body: each
 * model keeps the schema its vendor wrote.
 *
 * Keyed by endpoint prefix rather than by model, so a new model from a
 * known vendor needs no entry. An encoding table, not a capability table:
 * it changes only when a vendor changes its wire format.
 *
 * Sourced from fal's OpenAPI documents
 * (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`).
 */
export type VideoWire = {
  /** Wire field for a first frame. `None` where the family takes none. */
  readonly firstFrame: Option.Option<string>
  readonly lastFrame: Option.Option<string>
  /** `None` where the family has no duration field at all. */
  readonly duration: Option.Option<(seconds: number) => string | number>
  /** Spellings this family accepts, by portable tier. */
  readonly resolutions: { readonly [K in VideoResolution]?: string }
}

type Frames = Pick<VideoWire, "firstFrame" | "lastFrame">

const IMAGE_FRAMES: Frames = {
  firstFrame: Option.some("image_url"),
  lastFrame: Option.some("end_image_url"),
}

const START_FRAMES: Frames = {
  firstFrame: Option.some("start_image_url"),
  lastFrame: Option.some("end_image_url"),
}

const NO_FRAMES: Frames = { firstFrame: Option.none(), lastFrame: Option.none() }

const seconds = Option.some((s: number) => s)
const secondsText = Option.some((s: number) => `${s}`)
const secondsSuffixed = Option.some((s: number) => `${s}s`)

/** Prefixes are disjoint, so the first match is the only match. */
const FAMILIES: ReadonlyArray<readonly [string, VideoWire]> = [
  [
    "minimax/",
    {
      ...IMAGE_FRAMES,
      duration: seconds,
      // 768P has no portable tier; ask for it through `input`.
      resolutions: { "480p": "480P", "1080p": "1080P" },
    },
  ],
  [
    "bytedance/",
    {
      ...IMAGE_FRAMES,
      duration: secondsText,
      resolutions: { "480p": "480p", "720p": "720p", "1080p": "1080p" },
    },
  ],
  [
    "lightricks/",
    {
      ...IMAGE_FRAMES,
      duration: seconds,
      resolutions: { "720p": "720p", "1080p": "1080p", "4k": "2160p" },
    },
  ],
  [
    "alibaba/",
    {
      ...START_FRAMES,
      duration: seconds,
      resolutions: { "480p": "480p", "720p": "720p", "1080p": "1080p" },
    },
  ],
  [
    "fal-ai/veo",
    {
      ...IMAGE_FRAMES,
      duration: secondsSuffixed,
      resolutions: { "720p": "720p", "1080p": "1080p", "4k": "4k" },
    },
  ],
  // Resolution is not a field on Kling v3 pro; 4K is its own endpoint.
  ["fal-ai/kling-video/", { ...START_FRAMES, duration: secondsText, resolutions: {} }],
  // Frame-counted rather than timed, and sized by a `video_size` preset.
  ["fal-ai/ltx-2", { ...NO_FRAMES, duration: Option.none(), resolutions: {} }],
]

/** Everything portable goes through `input`, loudly rather than guessed. */
const UNKNOWN: VideoWire = { ...NO_FRAMES, duration: Option.none(), resolutions: {} }

export const wireOf = (endpoint: string): VideoWire =>
  pipe(
    Arr.findFirst(FAMILIES, ([prefix]) => endpoint.startsWith(prefix)),
    Option.match({ onNone: () => UNKNOWN, onSome: ([, wire]) => wire }),
  )

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

const dropped = (field: string, endpoint: string): Effect.Effect<Record<string, unknown>> =>
  Effect.as(
    Capabilities.warnDropped({
      provider: PROVIDER,
      capability: field,
      field,
      reason: `No \`${field}\` field is known for \`${endpoint}\`. Set it through \`input\` under the name the endpoint documents.`,
    }),
    {},
  )

/** Whole seconds: no fal endpoint takes a finer duration. */
const encodeDuration = (
  wire: VideoWire,
  endpoint: string,
  duration: Duration.Duration,
): Effect.Effect<Record<string, unknown>> =>
  Option.match(wire.duration, {
    onNone: () => dropped("duration", endpoint),
    onSome: (encode) =>
      Effect.succeed({ duration: encode(Math.round(Duration.toSeconds(duration))) }),
  })

export const durationField = (
  wire: VideoWire,
  endpoint: string,
  duration: Duration.Duration | undefined,
): Effect.Effect<Record<string, unknown>> =>
  Option.match(Option.fromNullishOr(duration), {
    onNone: () => Effect.succeed<Record<string, unknown>>({}),
    onSome: (d) => encodeDuration(wire, endpoint, d),
  })

const unsupportedTier = (
  wire: VideoWire,
  endpoint: string,
  resolution: VideoResolution,
): AiError.AiError =>
  new AiError.Unsupported({
    provider: PROVIDER,
    capability: "resolution",
    reason: `\`${endpoint}\` renders ${Object.keys(wire.resolutions).join(", ")}, not ${resolution}. Set \`input.resolution\` for a tier this family spells differently.`,
  })

/**
 * Tiers are not shared: ours are scan heights, and a family with no
 * equivalent would otherwise render a different clip than was asked for.
 * So a missing tier fails rather than rounding to a neighbour.
 */
const encodeResolution = (
  wire: VideoWire,
  endpoint: string,
  resolution: VideoResolution,
): Effect.Effect<Record<string, unknown>, AiError.AiError> =>
  Object.keys(wire.resolutions).length === 0
    ? dropped("resolution", endpoint)
    : Option.match(Option.fromNullishOr(wire.resolutions[resolution]), {
        onNone: () => Effect.fail(unsupportedTier(wire, endpoint, resolution)),
        onSome: (spelling) => Effect.succeed({ resolution: spelling }),
      })

export const resolutionField = (
  wire: VideoWire,
  endpoint: string,
  resolution: VideoResolution | undefined,
): Effect.Effect<Record<string, unknown>, AiError.AiError> =>
  Option.match(Option.fromNullishOr(resolution), {
    onNone: () => Effect.succeed<Record<string, unknown>>({}),
    onSome: (tier) => encodeResolution(wire, endpoint, tier),
  })
