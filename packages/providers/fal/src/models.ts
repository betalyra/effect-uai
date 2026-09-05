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
