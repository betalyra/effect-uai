/**
 * fal endpoint identifiers (as of September 2026). Unlike every other
 * provider here, the "model" is a *path*: it selects the endpoint, and
 * text-to-image and edit are separate endpoints of the same model
 * family. Pass a `FalImageModel` to `generate` and a `FalImageEditModel`
 * to `edit`.
 *
 * The `(string & {})` tail keeps autocomplete on the literals while
 * accepting any string, so fal's whole catalogue works without an SDK
 * update: the id is the model page's URL after `fal.ai/models/`.
 *
 * Read that literally. Whether an id carries the `fal-ai/` prefix varies
 * even between generations of one model (`fal-ai/bytedance/seedream/v4.5/edit`
 * has it, `bytedance/seedream/v5/pro/text-to-image` does not), and a
 * wrong guess is fal's "Application not found", not a 404 you can read.
 *
 * Reference: https://fal.ai/models
 */
export type FalImageModel =
  | "fal-ai/flux-2-pro"
  | "fal-ai/flux/schnell"
  | "fal-ai/flux/dev"
  | "bytedance/seedream/v5/pro/text-to-image"
  | "alibaba/qwen-image-3/text-to-image"
  | "meta/muse-image/text-to-image"
  | "openai/gpt-image-2"
  | "fal-ai/nano-banana-2"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Video endpoints. Text-to-video and image-to-video are separate endpoints
 * of the same family, so the first-frame input selects the id rather than a
 * flag: `minimax/h3-max/text-to-video` versus `minimax/h3-max/image-to-video`.
 *
 * The turbo tier is what makes continuous generation viable. fal measured
 * `minimax/h3-max-turbo/text-to-video` at 1.61 s for a 5 second clip, which
 * is faster than the clip plays.
 *
 * Reference: https://fal.ai/models?categories=text-to-video
 */
export type FalVideoModel =
  | "minimax/h3-max-turbo/text-to-video"
  | "minimax/h3-max/text-to-video"
  | "minimax/h3-max/image-to-video"
  | "bytedance/seedance-2.5/text-to-video"
  | "bytedance/seedance-2.5/image-to-video"
  | "fal-ai/veo3.1"
  | "fal-ai/veo3.1/fast"
  | "fal-ai/kling-video/v3/pro/text-to-video"
  | "fal-ai/kling-video/v3/turbo/pro/text-to-video"
  | "lightricks/ltx-2.5/text-to-video/fast"
  | "fal-ai/ltx-2-19b/text-to-video"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})

/**
 * Edit endpoints. A generate id sent to `edit` gets fal's 422 for an
 * unknown field.
 *
 * Which wire field the references ride in differs per endpoint and the
 * adapter works that out on its own, so any edit endpoint fal hosts
 * works here, single-image ones included.
 */
export type FalImageEditModel =
  | "fal-ai/flux-2-pro/edit"
  | "bytedance/seedream/v5/pro/edit"
  | "fal-ai/bytedance/seedream/v4.5/edit"
  | "alibaba/qwen-image-3/edit"
  | "fal-ai/nano-banana-2/edit"
  | "openai/gpt-image-2/edit"
  | "fal-ai/qwen-image-edit"
  | "fal-ai/flux/dev/image-to-image"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
